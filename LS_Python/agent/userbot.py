"""
Userbot manager: handles Telegram login (producing a session string) and joining
live streams (group video chats) in listen-only mode.

Uses:
  * pyrofork  -> imported as `pyrogram` (the maintained fork that works with pytgcalls)
  * py-tgcalls -> joins the group call / live stream

Login is two-phase because the login code arrives on the phone:
  * begin_login()   -> sends the code, returns a phone_code_hash
  * complete_login()-> submits code (+ 2FA password), returns the session string

Once an account is logged in, we keep its Client + PyTgCalls alive in a pool so
it can join multiple live streams without re-logging-in.
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Optional

from pyrogram import Client, filters
from pyrogram.errors import (
    SessionPasswordNeeded,
    PhoneCodeInvalid,
    PhoneCodeExpired,
    ChatAdminRequired,
    FloodWait,
)
from pyrogram.handlers import MessageHandler
from pyrogram.raw.functions.messages import GetMessagesViews
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream


class LoginNeeds2FA(Exception):
    """Raised when the account has two-factor auth and we need the password."""


class UserbotError(Exception):
    pass


class NoActiveLivestream(UserbotError):
    """Raised when the chat has no live stream / video chat running to join."""


class FloodWaitError(UserbotError):
    """
    Raised when Telegram rate-limits a call and the required wait is too long to
    sit through inline. Carries `.seconds` so the worker can RESCHEDULE the job
    to run later (durable retry) instead of failing it permanently.
    """

    def __init__(self, seconds: int, what: str = "request"):
        self.seconds = int(seconds)
        self.what = what
        super().__init__(f"Rate limited by Telegram on {what}, retry in {self.seconds}s.")


# In-memory pool of live userbots, keyed by account_id.
# { account_id: {"client": Client, "calls": PyTgCalls} }
_POOL: dict[int, dict] = {}

# --- Live-stream join throttling -------------------------------------------
# Joining a group call is FAR heavier than a normal API call: every join
# negotiates a full WebRTC/NTgCalls connection (ICE + DTLS + native threads)
# and Telegram rate-limits group-call joins aggressively per-chat. Firing
# hundreds of joins at once (which is what happened before) melts the process
# and makes Telegram silently drop most bots — so "bots sent, none appear".
#
# Instead we cap how many joins run CONCURRENTLY with a semaphore and trickle
# them in with a small jittered gap, so even 1000 accounts join smoothly and
# look like real viewers arriving. Tune with AGENT_JOIN_CONCURRENCY (how many
# joins at once) and AGENT_JOIN_STAGGER_SECONDS (base gap between each join
# acquiring a slot). Both are read once here; created lazily inside the loop.
import os as _os

JOIN_MAX_CONCURRENCY = max(1, int(_os.environ.get("AGENT_JOIN_CONCURRENCY", "8")))
JOIN_STAGGER_SECONDS = max(0.0, float(_os.environ.get("AGENT_JOIN_STAGGER_SECONDS", "0.4")))
# How many times a SINGLE join retries transient (non-flood) errors before it
# gives up and the job is marked failed. Floods are handled separately (durable
# reschedule by the worker), so this is only for momentary network / call hiccups.
JOIN_RETRY_ATTEMPTS = max(1, int(_os.environ.get("AGENT_JOIN_RETRY_ATTEMPTS", "3")))

# CRITICAL keep-alive rule: a bot must NEVER be abandoned because of a momentary
# hiccup. The reconciler only stops tracking (releases) the bots for a chat after
# it has confirmed the host's live stream is REALLY gone this many times IN A ROW.
# Until then every dropped bot is rejoined forever. With AGENT_RECONCILE_SECONDS
# at 15s, the default of 4 means we only let go ~60s after the stream truly ends —
# so a transient GetFullChannel blip can never make hundreds of bots leave.
STREAM_GONE_CONFIRMATIONS = max(1, int(_os.environ.get("AGENT_STREAM_GONE_CONFIRMATIONS", "4")))

# Exponential backoff between failed rejoin attempts for a SINGLE bot. This is
# what stops a mass recovery from turning into a re-play() storm: instead of
# re-joining every dropped bot on every 15s sweep, a bot that just failed waits
# BASE, then 2x, 4x… up to MAX before its next try. That keeps the shared event
# loop responsive so the native WebRTC keepalives fire on time and connections
# actually survive. A bot is still NEVER abandoned — it just retries more gently.
REJOIN_BACKOFF_BASE_SECONDS = max(1.0, float(_os.environ.get("AGENT_REJOIN_BACKOFF_BASE", "10")))
REJOIN_BACKOFF_MAX_SECONDS = max(
    REJOIN_BACKOFF_BASE_SECONDS, float(_os.environ.get("AGENT_REJOIN_BACKOFF_MAX", "120"))
)

# Accounts that are SUPPOSED to be in a live stream right now, so we can put
# them back if Telegram/NTgCalls drops the call (network blip, server move, or a
# server-side call restart — the usual cause of "300 joined, 270 suddenly left").
# We also stash the account's creds so a dropped/disconnected client can be
# fully revived (not just re-played) during recovery.
# { account_id: {"chat_id": int, "chat_link": str,
#                "api_id": int, "api_hash": str, "session_string": str} }
_ACTIVE_JOINS: dict[int, dict] = {}

# Our OWN view of each account's live-call state, updated from pytgcalls events.
# This is version-independent (does not depend on pytgcalls exposing an internal
# "active calls" dict, which most versions don't), so the reconciler can always
# tell who dropped. Values: "connected" | "dropped".
_LIVE_STATE: dict[int, str] = {}

# Clients that already have the auto-rejoin handler attached (attach once).
_REJOIN_ATTACHED: set[int] = set()

# Per-chat count of consecutive "the live stream looks gone" readings. We only
# release a chat's bots once this reaches STREAM_GONE_CONFIRMATIONS, so a single
# transient false reading can never make everyone leave. Reset the instant the
# stream looks alive again.
_STREAM_GONE_STRIKES: dict[int, int] = {}

# Per-account count of consecutive failed rejoin attempts. Drives the backoff
# below. A failing bot is retried forever, never abandoned — just less often.
_JOIN_FAILS: dict[int, int] = {}

# Per-account earliest monotonic time we may retry a failed rejoin. Set from the
# exponential backoff after a failure; cleared on success or intentional leave.
_NEXT_RETRY_AT: dict[int, float] = {}

_join_sem: "asyncio.Semaphore | None" = None


def _get_join_sem() -> asyncio.Semaphore:
    """Bounded concurrency gate for group-call joins (created in the loop)."""
    global _join_sem
    if _join_sem is None:
        _join_sem = asyncio.Semaphore(JOIN_MAX_CONCURRENCY)
    return _join_sem


def _flood_seconds(exc: Exception) -> int | None:
    """
    If `exc` is (or wraps) a Telegram FloodWait, return the required wait in
    seconds; otherwise None. pyrofork exposes the seconds as `.value`; some
    ntgcalls wrappers surface it as `.x` or in the message text.
    """
    if isinstance(exc, FloodWait):
        return int(getattr(exc, "value", None) or getattr(exc, "x", 0) or 0) or None
    # ntgcalls sometimes re-raises floods as a generic error carrying the text.
    msg = str(exc)
    if "FLOOD_WAIT" in msg or "flood" in msg.lower():
        import re
        m = re.search(r"(\d+)", msg)
        if m:
            return int(m.group(1))
    return None

# In-memory pool of IN-PROGRESS login clients, keyed by phone number.
# The userbot login is split across two jobs (send_login_code -> submit_login_code)
# that both run inside this same long-running worker process. We MUST keep the
# connected Client alive between them instead of exporting a half-finished
# session string: exporting a session before sign-in packs an empty user_id and
# crashes with "required argument is not an integer".
# { phone: {"client": Client, "code_ok": bool} }
_LOGIN_POOL: dict[str, dict] = {}


async def _drop_login_client(phone: str) -> None:
    """Disconnect and forget an in-progress login client."""
    entry = _LOGIN_POOL.pop(phone, None)
    if entry:
        try:
            await entry["client"].disconnect()
        except Exception:
            pass


async def begin_login(api_id: int, api_hash: str, phone: str) -> tuple[str, str]:
    """
    Phase 1 of userbot login. Sends the login code to the phone and keeps the
    connected client alive (in _LOGIN_POOL) so phase 2 can finish on the SAME
    client. Returns ("", phone_code_hash).

    We intentionally do NOT export a session string here: the client is not
    authorized yet (no user_id), and exporting it raises
    "required argument is not an integer".
    """
    # Clear any stale half-finished attempt for this phone.
    await _drop_login_client(phone)

    client = Client(
        name=f"login_{phone}",
        api_id=int(api_id),
        api_hash=api_hash,
        in_memory=True,
        phone_number=phone,
        # Login only signs in / sets a session; it never consumes updates. Off it
        # goes so no background handle_updates() task races with disconnect() and
        # throws "Cannot operate on a closed database".
        no_updates=True,
    )
    await client.connect()
    sent = await client.send_code(phone)
    # Keep the connected client for phase 2 instead of exporting a partial session.
    _LOGIN_POOL[phone] = {"client": client, "code_ok": False}
    return "", sent.phone_code_hash


async def complete_login(
    api_id: int,
    api_hash: str,
    phone: str,
    session_string: str,
    phone_code_hash: str,
    code: str,
    password: Optional[str] = None,
) -> str:
    """
    Phase 2: submit the code (and 2FA password if set) on the SAME client kept
    alive from phase 1. Returns the final (authorized) session string to store.
    """
    entry = _LOGIN_POOL.get(phone)
    if entry is None:
        # The worker likely restarted between the two jobs, so the in-memory
        # login client is gone. The user must request a fresh code.
        raise UserbotError(
            "Login session expired (agent restarted). Click Verify again to resend the code."
        )

    client: Client = entry["client"]
    try:
        if not entry["code_ok"]:
            # We still need to submit the login code.
            try:
                await client.sign_in(phone, phone_code_hash, code)
                entry["code_ok"] = True
            except SessionPasswordNeeded:
                entry["code_ok"] = True  # code accepted; 2FA password still needed
                if not password:
                    # Keep the client alive for the follow-up password submission.
                    raise LoginNeeds2FA("This account has 2FA enabled. Password required.")
                await client.check_password(password)
            except (PhoneCodeInvalid, PhoneCodeExpired) as e:
                await _drop_login_client(phone)
                raise UserbotError(f"Login code problem: {e.__class__.__name__}")
        else:
            # Code was already accepted on a previous job; this call carries the 2FA password.
            if not password:
                raise LoginNeeds2FA("This account has 2FA enabled. Password required.")
            await client.check_password(password)

        final_session = await client.export_session_string()
    except (LoginNeeds2FA, UserbotError):
        raise
    except Exception as e:
        # Wrong 2FA password or any other hard failure -> reset so the user can retry.
        await _drop_login_client(phone)
        raise UserbotError(f"Login failed: {e.__class__.__name__}: {e}")

    await _drop_login_client(phone)
    return final_session


async def provision_userbot(
    api_id: int,
    api_hash: str,
    phone: str,
    fetch_code,
    old_password: Optional[str],
    new_password: str,
) -> dict:
    """
    Fully automatic userbot login used by the tg-lion flow (no human types a
    code). Steps, all on ONE connected client:

      1. send_code(phone)               -> Telegram delivers a login code
      2. code, pw = await fetch_code()  -> read that code AND the account's
                                           current cloud password from tg-lion
                                           (both come from the SAME getCode call)
      3. sign_in(code)                  -> if 2FA is on, Telegram raises
                                           SessionPasswordNeeded; we then
                                           check_password with the password
                                           tg-lion just gave us (falling back to
                                           old_password)
      4. TWO-STEP HANDLING (per request):
           - if the account HAD a 2FA password -> remove it (turn it OFF), then
           - set OUR new 2FA password (enable). If a password somehow still
             exists we fall back to change_cloud_password.
      5. export the authorized session string.

    `fetch_code` is an async-or-sync callable returning either the login code
    string, or a (code, password) tuple. The password is the account's current
    cloud password as reported by tg-lion's getCode `pass` field, and is what
    unlocks 2FA at sign-in — so it MUST be read from the same response as the
    code (that is why it is returned here rather than passed in up front).
    Returns { session_string, had_2fa, two_step_set }.
    """
    client = Client(
        name=f"prov_{phone}",
        api_id=int(api_id),
        api_hash=api_hash,
        in_memory=True,
        phone_number=phone,
        # We only sign in and set 2FA here — we never consume incoming updates.
        # Leaving update dispatching on means pyrogram spawns a background
        # handle_updates() task that writes to the session's SQLite storage; when
        # we disconnect() below that storage closes, and any in-flight update
        # throws "Cannot operate on a closed database". Turning updates off
        # removes that task entirely and the harmless error with it.
        no_updates=True,
    )
    await client.connect()
    had_2fa = False
    try:
        sent = await client.send_code(phone)

        # Pull the freshly-sent login code (and the account's current cloud
        # password) from tg-lion. fetch_code may return just the code, or a
        # (code, password) tuple — the password is what unlocks 2FA.
        fetched = fetch_code()
        if asyncio.iscoroutine(fetched):
            fetched = await fetched
        code_password: Optional[str] = None
        if isinstance(fetched, (tuple, list)):
            code = fetched[0]
            code_password = fetched[1] if len(fetched) > 1 else None
        else:
            code = fetched
        code = str(code).strip()
        if not code:
            raise UserbotError("No login code was available from tg-lion.")

        # The password that came WITH this code wins; fall back to whatever was
        # passed in (e.g. a value persisted from an earlier attempt).
        unlock_password = code_password or old_password

        try:
            await client.sign_in(phone, sent.phone_code_hash, code)
        except SessionPasswordNeeded:
            had_2fa = True
            if not unlock_password:
                raise UserbotError(
                    "Account has a 2FA password but tg-lion did not provide one. "
                    "Cannot log in automatically."
                )
            await client.check_password(unlock_password)
            old_password = unlock_password  # used again below to remove the 2FA
        except (PhoneCodeInvalid, PhoneCodeExpired) as e:
            raise UserbotError(f"Login code problem: {e.__class__.__name__}")

        # ---- Two-step (cloud password) management -------------------------
        # Requirement: if a password exists, turn it OFF first, then set OUR new
        # one. If none exists, just set ours.
        two_step_set = False
        try:
            if had_2fa and old_password:
                # Turn the existing password OFF, then enable our new one fresh.
                try:
                    await client.remove_cloud_password(old_password)
                except Exception as e:
                    # Some libs disallow remove+enable; fall back to a direct change.
                    await client.change_cloud_password(old_password, new_password)
                    two_step_set = True
                    print(f"[prov] {phone}: changed existing 2FA password directly.")
                if not two_step_set:
                    await client.enable_cloud_password(new_password, hint="")
                    two_step_set = True
                    print(f"[prov] {phone}: old 2FA removed, new 2FA set.")
            else:
                # No existing password -> just enable ours.
                await client.enable_cloud_password(new_password, hint="")
                two_step_set = True
                print(f"[prov] {phone}: new 2FA set (no prior password).")
        except Exception as e:
            # An account may already carry our password from a partial prior run.
            try:
                await client.change_cloud_password(new_password, new_password)
                two_step_set = True
            except Exception:
                # Don't fail the whole login just because 2FA (re)set hiccuped;
                # surface it via the flag so the worker can record a warning.
                print(f"[prov] {phone}: WARNING could not set 2FA password: {e}")

        final_session = await client.export_session_string()
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass

    return {"session_string": final_session, "had_2fa": had_2fa, "two_step_set": two_step_set}


async def _ensure_online(account_id: int, api_id: int, api_hash: str, session_string: str) -> dict:
    """Start (or reuse) a live Client + PyTgCalls for this account."""
    if account_id in _POOL:
        return _POOL[account_id]

    client = Client(
        name=f"bot_{account_id}",
        api_id=api_id,
        api_hash=api_hash,
        session_string=session_string,
        in_memory=True,
    )
    await client.start()
    calls = PyTgCalls(client)
    await calls.start()
    _POOL[account_id] = {"client": client, "calls": calls}
    _attach_rejoin_handler(account_id, calls)
    return _POOL[account_id]


def _attach_rejoin_handler(account_id: int, calls: PyTgCalls) -> None:
    """
    When this account's group call ends/drops unexpectedly while it is still
    supposed to be listening, MARK it dropped so the throttled reconciler brings
    it back. We deliberately do NOT rejoin inline here: when a server-side call
    restart drops hundreds of bots at the same instant, hundreds of inline
    rejoins would fire simultaneously, bypass the concurrency gate, and overload
    the process again — causing the very oscillation we're fixing. Marking +
    centralised throttled recovery makes even a full mass-drop come back
    smoothly. Guarded + feature-detected so it can never crash the agent.
    """
    if account_id in _REJOIN_ATTACHED:
        return
    on_update = getattr(calls, "on_update", None)
    if not callable(on_update):
        return

    try:

        @on_update()
        async def _on_call_update(_client, update) -> None:  # noqa: ANN001
            try:
                name = update.__class__.__name__.lower()
                if account_id not in _ACTIVE_JOINS:
                    return  # we intentionally left — ignore.

                # CRITICAL: a listen-only join publishes no media, so pytgcalls
                # fires StreamEnded (and pause/resume) almost immediately even
                # though the bot is STILL in the call as a listener. Treating
                # that as a "drop" made the reconciler re-play() the bot every
                # sweep, and with every bot in one event loop that re-play storm
                # starved the WebRTC keepalives and got everyone kicked. So these
                # routine media events are explicitly NOT membership changes.
                if any(k in name for k in ("streamend", "ended", "pause", "resume")):
                    return

                # Only events that mean the bot TRULY left the call count as a
                # drop. (LeftGroupCall / KickedFromGroupCall / Disconnected /
                # ClosedVoiceChat.) The reconciler then rejoins it — unless the
                # host's whole stream has ended, which its per-chat liveness check
                # confirms separately.
                if any(k in name for k in ("left", "leav", "kick", "disconnect", "closed")):
                    _LIVE_STATE[account_id] = "dropped"
                # A positive "joined/connected" event confirms health.
                elif any(k in name for k in ("join", "connect")):
                    _LIVE_STATE[account_id] = "connected"
            except Exception:
                # Never let an update handler crash the client's update loop.
                pass

        _REJOIN_ATTACHED.add(account_id)
    except Exception as e:
        print(f"[!] could not attach rejoin handler for account {account_id}: {e}")


async def prewarm(accounts: list[dict]) -> int:
    """
    Connect every already-logged-in account up front and keep it in _POOL.

    The slowest part of joining a live stream is the per-account cold start
    (client.start(): MTProto handshake + auth + updates sync). By doing it once
    at agent startup, later join jobs only have to run calls.play(), which is
    near-instant. Returns how many clients are now warm.

    Connections are opened concurrently so warming 100 accounts takes about as
    long as warming one.
    """
    async def _warm(acc: dict) -> bool:
        try:
            await _ensure_online(
                acc["id"], int(acc["api_id"]), acc["api_hash"], acc["session_string"]
            )
            return True
        except Exception as e:
            print(f"[!] prewarm failed for account {acc.get('id')}: {e}")
            return False

    results = await asyncio.gather(*(_warm(a) for a in accounts))
    return sum(1 for ok in results if ok)


def _listen_only_stream() -> MediaStream:
    """
    A MediaStream that publishes NOTHING (listen-only). With both audio and
    video flags set to IGNORE, NTgCalls never opens/probes the placeholder path,
    so the file does not need to exist — this is the documented py-tgcalls 2.x
    way to join a call as a pure listener.
    """
    return MediaStream(
        "input.raw",
        audio_flags=MediaStream.Flags.IGNORE,
        video_flags=MediaStream.Flags.IGNORE,
    )


def _already_in_call(exc: Exception) -> bool:
    """True when a join error just means this bot is already in the call."""
    m = str(exc).lower()
    return "already" in m and ("call" in m or "join" in m)


def _forget_join(account_id: int) -> None:
    """Stop tracking an account for live-stream keep-alive (intentional leave or
    a stream that has genuinely ended). Clears the target and all state views."""
    _ACTIVE_JOINS.pop(account_id, None)
    _LIVE_STATE.pop(account_id, None)
    _JOIN_FAILS.pop(account_id, None)
    _NEXT_RETRY_AT.pop(account_id, None)


async def _teardown_client(account_id: int) -> None:
    """
    Fully drop a userbot's Client + PyTgCalls so the next rejoin rebuilds it from
    scratch. Used when a client has died (network/process churn): re-playing on a
    dead client would silently fail forever, so we rebuild instead. This keeps a
    bot recoverable indefinitely rather than stuck 'dropped'. Never raises.
    """
    entry = _POOL.pop(account_id, None)
    _REJOIN_ATTACHED.discard(account_id)
    if not entry:
        return
    client = entry.get("client")
    try:
        if client is not None:
            await client.stop()
    except Exception:
        pass


def _connected_chat_ids(calls: PyTgCalls) -> set[int] | None:
    """
    Best-effort set of chat_ids this PyTgCalls instance currently has an ACTIVE
    call in. py-tgcalls versions differ, so we feature-detect a few known
    accessors. Returns None when we genuinely cannot tell — in that case we fall
    back to our own event-tracked _LIVE_STATE, which is always available.
    """
    for attr in ("calls", "active_calls", "_calls"):
        holder = getattr(calls, attr, None)
        if isinstance(holder, dict):
            try:
                return {int(k) for k in holder.keys()}
            except Exception:
                continue
    return None


async def _rejoin_one(account_id: int, target: dict) -> bool:
    """
    Bring a single dropped account back into its live stream, THROUGH the shared
    join throttle (concurrency gate + stagger) so a mass recovery never spikes.

    Key rule: this NEVER gives up on a bot. If the client died it is rebuilt from
    scratch; if the rejoin fails right now (rate limit, momentary error) the bot
    simply stays 'dropped' and is retried on the next sweep. The only thing that
    ever stops a bot being tracked is the stream genuinely ending (decided once,
    per-chat, in reconcile_active_joins) or the user leaving. Never raises.

    Whether the host's stream is still running is decided ONCE per chat by the
    caller — we intentionally do NOT check it here, because doing so per-account
    fired a GetFullChannel from every client every sweep and that flood was itself
    a cause of the mass-drop we are healing.
    """
    chat_id = int(target["chat_id"])
    async with _get_join_sem():
        if JOIN_STAGGER_SECONDS > 0:
            await asyncio.sleep(random.uniform(0.0, JOIN_STAGGER_SECONDS))
        try:
            # Revive the client/calls pair if it was lost (process churn, pyrogram
            # disconnect). A pooled-but-dead client can't rejoin, so rebuild it.
            entry = _POOL.get(account_id)
            if entry is not None:
                client = entry.get("client")
                if client is not None and not getattr(client, "is_connected", True):
                    await _teardown_client(account_id)
                    entry = None
            if not entry:
                entry = await _ensure_online(
                    account_id,
                    int(target["api_id"]),
                    target["api_hash"],
                    target["session_string"],
                )
            calls: PyTgCalls = entry["calls"]

            await calls.play(chat_id, _listen_only_stream())
            _LIVE_STATE[account_id] = "connected"
            _JOIN_FAILS.pop(account_id, None)
            _NEXT_RETRY_AT.pop(account_id, None)
            return True
        except Exception as e:
            if _already_in_call(e):
                _LIVE_STATE[account_id] = "connected"
                _JOIN_FAILS.pop(account_id, None)
                _NEXT_RETRY_AT.pop(account_id, None)
                return True
            # Could not rejoin right now (rate limit / transient error). Stay
            # 'dropped' — we NEVER abandon the bot — but back off before the next
            # try so a wave of failures can't re-play-storm the event loop.
            fails = _JOIN_FAILS.get(account_id, 0) + 1
            _JOIN_FAILS[account_id] = fails
            delay = min(
                REJOIN_BACKOFF_MAX_SECONDS,
                REJOIN_BACKOFF_BASE_SECONDS * (2 ** (fails - 1)),
            )
            # Small jitter so many bots don't all come off backoff on the same tick.
            delay += random.uniform(0.0, min(5.0, delay * 0.25))
            _NEXT_RETRY_AT[account_id] = time.monotonic() + delay
            _LIVE_STATE[account_id] = "dropped"
            return False


async def reconcile_active_joins() -> int:
    """
    Relentless keep-alive that makes "300 joined, 270 suddenly left" self-heal and
    keeps every bot in the stream for as long as the agent runs and the host's
    stream stays live — bots only ever leave when YOU stop the task.

    Two design rules make this robust (and fix the old auto-drop bug):

      1. Liveness is checked ONCE PER CHAT (not per account). The old code called
         GetFullChannel from every dropped client every sweep; with hundreds of
         bots that flood was itself a cause of the mass-drop, and a single
         transient "call is None" reading made it `_forget_join` the bot forever
         (so dropped bots vanished from the backend and the panel and never came
         back). Now one warm client answers for the whole chat.

      2. We only RELEASE a chat's bots after the stream is confirmed gone
         STREAM_GONE_CONFIRMATIONS times in a row. A momentary blip can never make
         everyone leave; while the stream is live (or we're unsure) every dropped
         bot is rejoined through the throttle, forever.

    Returns how many bots were rejoined this sweep.
    """
    if not _ACTIVE_JOINS:
        return 0

    now = time.monotonic()

    # Group the accounts that SHOULD be live by their chat, so each stream's
    # liveness is checked a single time regardless of how many bots are in it.
    by_chat: dict[int, list[tuple[int, dict]]] = {}
    for account_id, target in list(_ACTIVE_JOINS.items()):
        by_chat.setdefault(int(target["chat_id"]), []).append((account_id, target))

    to_rejoin: list[tuple[int, dict]] = []

    for chat_id, members in by_chat.items():
        # --- Is the host's live stream still running? Ask ONCE, via any warm
        #     client we still hold for this chat. _has_active_group_call already
        #     returns True on a transient error, so `live` is only False when the
        #     call is genuinely absent.
        live = True
        for account_id, _t in members:
            entry = _POOL.get(account_id)
            if entry is not None and getattr(entry.get("client"), "is_connected", False):
                try:
                    live = await _has_active_group_call(entry["client"], chat_id)
                except Exception:
                    live = True  # never treat an error as "stream gone"
                break

        if not live:
            # Might be over — but require several consecutive confirmations so a
            # single blip can NEVER evict everyone. Keep rejoining until then.
            strikes = _STREAM_GONE_STRIKES.get(chat_id, 0) + 1
            _STREAM_GONE_STRIKES[chat_id] = strikes
            if strikes >= STREAM_GONE_CONFIRMATIONS:
                for account_id, _t in members:
                    _forget_join(account_id)
                _STREAM_GONE_STRIKES.pop(chat_id, None)
                print(
                    f"[rejoin] live stream in chat {chat_id} confirmed ended after "
                    f"{strikes} checks; released {len(members)} bot(s)."
                )
                continue
            # Not yet confirmed gone — fall through and keep everyone alive.
        else:
            _STREAM_GONE_STRIKES.pop(chat_id, None)

        # --- Decide which members have dropped and queue them for rejoin.
        for account_id, target in members:
            entry = _POOL.get(account_id)
            dropped = False
            if entry is not None:
                client = entry.get("client")
                if client is not None and not getattr(client, "is_connected", True):
                    # Client itself died — definitely needs a full rebuild+rejoin.
                    dropped = True
                    _LIVE_STATE[account_id] = "dropped"
                else:
                    connected = _connected_chat_ids(entry["calls"])
                    if connected is not None:
                        # Version exposes real state — trust it (and sync our view).
                        dropped = chat_id not in connected
                        _LIVE_STATE[account_id] = "dropped" if dropped else "connected"
                    else:
                        # Fall back to our own event-tracked state.
                        dropped = _LIVE_STATE.get(account_id) == "dropped"
            else:
                # Lost the client entirely — definitely needs reviving.
                dropped = True

            if dropped:
                # Respect per-account backoff: a bot that just failed waits its
                # exponential delay before the next try. This is what keeps a mass
                # recovery from re-play-storming the shared event loop (the storm
                # itself starves keepalives and drops connections). First-time
                # drops have no timer, so they retry on this very sweep.
                next_at = _NEXT_RETRY_AT.get(account_id)
                if next_at is None or now >= next_at:
                    to_rejoin.append((account_id, target))

    if not to_rejoin:
        return 0

    # Recover the due bots in parallel; the semaphore inside _rejoin_one paces it
    # so even a full mass-drop comes back smoothly without re-overloading the loop.
    results = await asyncio.gather(
        *(_rejoin_one(aid, tgt) for aid, tgt in to_rejoin),
        return_exceptions=True,
    )
    return sum(1 for r in results if r is True)


async def join_livestream(
    account_id: int, api_id: int, api_hash: str, session_string: str, chat_link: str
) -> None:
    """
    Make the userbot join the chat (if needed) and then its active live stream /
    video chat in LISTEN-ONLY mode (we send no audio/video).

    SCALE-SAFE: the actual group-call join runs behind a global semaphore so at
    most AGENT_JOIN_CONCURRENCY joins happen at once, with a small jittered gap
    between them. This keeps the WebRTC/NTgCalls layer from being flooded when
    500-1000 bots are told to join together, and makes bots arrive like real
    viewers. Transient errors are retried; Telegram FloodWaits are surfaced as
    FloodWaitError so the worker can durably reschedule the job (never dropping
    the bot permanently for a temporary rate limit).
    """
    # Serialize the heavy work (client cold-start + call negotiation) so a burst
    # of join jobs trickles through instead of hammering the process at once.
    async with _get_join_sem():
        # Jittered stagger so slots don't all fire on the same tick — natural
        # arrival pattern + extra breathing room for Telegram's join limits.
        if JOIN_STAGGER_SECONDS > 0:
            await asyncio.sleep(random.uniform(0.0, JOIN_STAGGER_SECONDS))

        entry = await _ensure_online(account_id, api_id, api_hash, session_string)
        client: Client = entry["client"]
        calls: PyTgCalls = entry["calls"]

        # 1) Resolve + join the chat so the userbot is a member.
        chat_id = await _resolve_and_join_chat(client, chat_link)

        # 2) Make sure a live stream / video chat is actually running. If it is
        #    NOT, pytgcalls would try phone.CreateGroupCall, which needs admin
        #    rights and fails with CHAT_ADMIN_REQUIRED. We only ever JOIN an
        #    existing stream, so we check first and report a clear error.
        if not await _has_active_group_call(client, chat_id):
            raise NoActiveLivestream(
                "No live stream is currently running in this chat. "
                "Start the live stream/video chat first, then add the link."
            )

        # Everything the reconciler needs to fully revive this bot after a drop.
        target_info = {
            "chat_id": chat_id,
            "chat_link": chat_link,
            "api_id": int(api_id),
            "api_hash": api_hash,
            "session_string": session_string,
        }

        # 3) Join the active group call (listen-only), retrying transient errors
        #    and converting Telegram floods into a durable reschedule.
        last_exc: Exception | None = None
        for attempt in range(1, JOIN_RETRY_ATTEMPTS + 1):
            try:
                await calls.play(chat_id, _listen_only_stream())
                # Remember we belong here so auto-rejoin can restore us on a drop.
                _ACTIVE_JOINS[account_id] = target_info
                _LIVE_STATE[account_id] = "connected"
                return  # joined successfully
            except ChatAdminRequired:
                # Race: the live stream ended between our check and the join.
                _forget_join(account_id)
                raise NoActiveLivestream(
                    "No live stream is currently running in this chat. "
                    "Start the live stream/video chat first, then add the link."
                )
            except Exception as e:
                # Already in the call from a previous attempt/run -> success.
                if _already_in_call(e):
                    _ACTIVE_JOINS[account_id] = target_info
                    _LIVE_STATE[account_id] = "connected"
                    return
                secs = _flood_seconds(e)
                if secs is not None:
                    # Too-long inline wait: hand back to the worker to retry
                    # later so this bot still joins once the limit clears. Don't
                    # arm auto-rejoin yet — it isn't in the call.
                    _forget_join(account_id)
                    raise FloodWaitError(secs, what="livestream join")
                last_exc = e
                if attempt < JOIN_RETRY_ATTEMPTS:
                    # Brief backoff for momentary network/call hiccups, then retry.
                    await asyncio.sleep(1.5 * attempt + random.uniform(0.0, 1.0))
                    continue
                _forget_join(account_id)
                raise UserbotError(
                    f"Failed to join live stream after {JOIN_RETRY_ATTEMPTS} tries: "
                    f"{e.__class__.__name__}: {e}"
                ) from last_exc


async def leave_livestream(account_id: int, chat_link: str) -> None:
    # Forget it FIRST so the auto-rejoin handler treats this as an intentional
    # leave and does not immediately drag the bot back into the call.
    _forget_join(account_id)
    entry = _POOL.get(account_id)
    if not entry:
        return
    client: Client = entry["client"]
    calls: PyTgCalls = entry["calls"]
    try:
        chat = await client.get_chat(_normalize_link(chat_link))
        await calls.leave_call(chat.id)
    except Exception:
        pass


async def leave_livestream_all(account_ids: list[int], chat_link: str) -> int:
    """
    Drop MANY userbots out of a chat's live stream at once.

    The numeric chat id is resolved a single time using any warm client, then a
    leave_call is fired on every warm client concurrently. Because all the leaves
    run in parallel (asyncio.gather), even 500-1000 userbots exit within a few
    seconds instead of trickling out one job at a time. Returns how many left.
    """
    if not account_ids:
        return 0

    # Intentional leave: forget these accounts up front so auto-rejoin ignores
    # the disconnect events we are about to trigger.
    for aid in account_ids:
        _forget_join(int(aid))

    link = _normalize_link(chat_link)

    # Resolve the numeric chat id once from any warm client we still hold.
    chat_id: int | None = None
    for aid in account_ids:
        entry = _POOL.get(aid)
        if not entry:
            continue
        try:
            chat = await entry["client"].get_chat(link)
            chat_id = chat.id
            break
        except Exception:
            continue

    async def _leave(aid: int) -> bool:
        entry = _POOL.get(aid)
        if not entry:
            return False
        calls: PyTgCalls = entry["calls"]
        try:
            target = chat_id
            if target is None:
                chat = await entry["client"].get_chat(link)
                target = chat.id
            await calls.leave_call(target)
            return True
        except Exception:
            return False

    results = await asyncio.gather(*(_leave(int(a)) for a in account_ids))
    return sum(1 for ok in results if ok)


async def _has_active_group_call(client: Client, chat_id: int) -> bool:
    """
    Return True if the chat currently has a live stream / video chat running.

    We read the chat's full info: Telegram only populates `call` when a group
    call is active. This lets us JOIN an existing stream without ever trying to
    CREATE one (which needs admin rights).
    """
    try:
        full = await client.invoke(
            __import__(
                "pyrogram.raw.functions.channels", fromlist=["GetFullChannel"]
            ).GetFullChannel(channel=await client.resolve_peer(chat_id))
        )
        return getattr(full.full_chat, "call", None) is not None
    except Exception:
        # Could be a basic group (not a channel) or a transient error. Fall back
        # to attempting the join; play() / our ChatAdminRequired catch handles it.
        return True


async def _resolve_and_join_chat(client: Client, chat_link: str) -> int:
    """Join the chat from a public username or a private invite link."""
    link = _normalize_link(chat_link)

    # Private invite links contain a '+' or 'joinchat'.
    if "+" in chat_link or "joinchat" in chat_link:
        try:
            chat = await client.join_chat(chat_link)
            return chat.id
        except Exception:
            # Already a member -> just resolve it.
            chat = await client.get_chat(link)
            return chat.id

    # Public username / link.
    try:
        await client.join_chat(link)
    except Exception:
        pass  # already a member, or join not required
    chat = await client.get_chat(link)
    return chat.id


def _normalize_link(chat_link: str) -> str:
    """Turn a t.me link into a username/identifier Pyrogram understands."""
    s = chat_link.strip()
    s = s.replace("https://", "").replace("http://", "")
    if s.startswith("t.me/"):
        s = s[len("t.me/"):]
    if s.startswith("@"):  # already a username
        return s
    # public username (no slashes, no '+')
    if "/" not in s and not s.startswith("+"):
        return s
    return chat_link  # private invite link: pass through as-is


# ===========================================================================
# Channel Join: get a userbot into a channel/group (no live stream / group call)
# ===========================================================================

# Telegram RPC error fragments that mean the userbot IS ALREADY a member. These
# must be treated as SUCCESS, never as a failure, so re-running a join is safe.
_ALREADY_MEMBER_MARKERS = (
    "USER_ALREADY_PARTICIPANT",
    "ALREADY A MEMBER",
    "ALREADY PARTICIPANT",
)

# Map common permanent join failures to a short, human-readable reason so the
# panel can show exactly WHY a userbot could not join, instead of a raw RPC name.
# Anything not listed here is reported with its own message but still never
# crashes the agent.
_JOIN_ERROR_REASONS = (
    ("INVITE_HASH_EXPIRED", "Invite link expired — get a fresh link."),
    ("INVITE_HASH_INVALID", "Invalid invite link."),
    ("INVITE_REQUEST_SENT", "Join request sent — waiting for admin approval."),
    ("USER_CHANNELS_TOO_MUCH", "This userbot is in too many chats already."),
    ("CHANNELS_TOO_MUCH", "This userbot is in too many chats already."),
    ("USERNAME_NOT_OCCUPIED", "No such channel/username — check the link."),
    ("USERNAME_INVALID", "Invalid channel username/link."),
    ("PEER_ID_INVALID", "Wrong or unreachable link."),
    ("CHANNEL_PRIVATE", "Channel is private — use an invite link."),
    ("CHANNEL_INVALID", "Invalid channel."),
    ("INVITE_HASH_EMPTY", "Empty invite link."),
    ("USER_BANNED_IN_CHANNEL", "This userbot is banned from that chat."),
    ("CHAT_INVALID", "Invalid chat link."),
    ("CHAT_WRITE_FORBIDDEN", "This userbot can't join that chat."),
)


def _classify_join_error(exc: Exception) -> str:
    """
    Turn a failed join into either the sentinel string 'already' (the bot is in
    fact already a member -> success) or a short human-readable failure reason.
    Uses text matching so it works across pyrofork versions without importing
    version-specific error classes.
    """
    text = f"{getattr(exc, 'ID', '')} {getattr(exc, 'MESSAGE', '')} {exc}".upper()
    for marker in _ALREADY_MEMBER_MARKERS:
        if marker in text:
            return "already"
    for marker, reason in _JOIN_ERROR_REASONS:
        if marker in text:
            return reason
    # Unknown but non-fatal: surface a trimmed generic message. Still no crash.
    return f"Could not join: {exc.__class__.__name__}"


async def _do_join_chat(client: Client, chat_link: str) -> str:
    """
    Join a public @username / t.me link OR a private invite link with ONE client.
    Returns "joined" or "already_member". Raises FloodWaitError for a durable
    retry, or UserbotError(reason) for a permanent, clearly-explained failure.
    Never lets a raw exception escape unclassified.
    """
    link = _normalize_link(chat_link)
    is_invite = ("+" in chat_link) or ("joinchat" in chat_link)
    join_arg = chat_link if is_invite else link

    try:
        await client.join_chat(join_arg)
        return "joined"
    except FloodWait as e:
        raise FloodWaitError(int(getattr(e, "value", None) or getattr(e, "x", 0) or 60), what="channel join")
    except Exception as e:
        secs = _flood_seconds(e)
        if secs is not None:
            raise FloodWaitError(secs, what="channel join")
        kind = _classify_join_error(e)
        if kind == "already":
            return "already_member"
        # Public links sometimes throw when a join isn't required but the bot can
        # still resolve the chat as an existing member — verify before failing.
        if not is_invite:
            try:
                await client.get_chat(link)
                return "already_member"
            except Exception:
                pass
        raise UserbotError(kind)


async def join_channel_only(
    account_id: int, api_id: int, api_hash: str, session_string: str, chat_link: str
) -> str:
    """
    Make ONE userbot join a channel / group (plain membership — NO live stream /
    group call). This is what gets bots into a chat so later view / react / vote
    actions work.

    Fault-tolerant by design (the whole point of the feature):
      * already a member            -> returns "already_member" (success)
      * expired / invalid / wrong link, private, banned, too many chats
                                    -> raises UserbotError with a clear reason so
                                       ONLY this bot is marked failed
      * Telegram flood/rate limit   -> raises FloodWaitError so the worker
                                       durably reschedules (bot still joins later)
    None of these ever crash the agent or log the userbot out.

    Reuses the account's warm client if one is already online (e.g. from a live
    stream); otherwise it spins up a lightweight in-memory client just for the
    join and shuts it down afterwards so we don't hold hundreds of idle clients.
    """
    # Trickle joins through the same concurrency gate + jitter as stream joins so
    # a 500-1000 bot burst arrives smoothly and stays inside Telegram's limits.
    async with _get_join_sem():
        if JOIN_STAGGER_SECONDS > 0:
            await asyncio.sleep(random.uniform(0.0, JOIN_STAGGER_SECONDS))

        reuse = _POOL.get(account_id)
        if reuse is not None:
            return await _do_join_chat(reuse["client"], chat_link)

        client = Client(
            name=f"join_{account_id}",
            api_id=api_id,
            api_hash=api_hash,
            session_string=session_string,
            in_memory=True,
        )
        await client.start()
        try:
            return await _do_join_chat(client, chat_link)
        finally:
            try:
                await client.stop()
            except Exception:
                pass


# ===========================================================================
# Live View: auto-view future channel posts with every logged-in userbot
# ===========================================================================

# Set by the worker. Called as: await _VIEW_DISPATCH(chat_id, message_id)
_VIEW_DISPATCH = None
# Set by the worker. Called as: await _REACTION_DISPATCH(chat_id, message_id)
_REACTION_DISPATCH = None
# Set by the worker. Called as:
#   await _MESSAGE_DISPATCH(account_id, body, telegram_message_id, sender, message_date)
_MESSAGE_DISPATCH = None


def set_view_dispatch(callback) -> None:
    """Register the worker callback that turns a detected post into view jobs."""
    global _VIEW_DISPATCH
    _VIEW_DISPATCH = callback


def set_reaction_dispatch(callback) -> None:
    """Register the worker callback that turns a detected post into reaction jobs."""
    global _REACTION_DISPATCH
    _REACTION_DISPATCH = callback


def set_message_dispatch(callback) -> None:
    """Register the worker callback that stores an incoming Telegram message."""
    global _MESSAGE_DISPATCH
    _MESSAGE_DISPATCH = callback


def _first_client() -> Optional[Client]:
    """Any warm client we can use to read public channel info / history."""
    for entry in _POOL.values():
        return entry["client"]
    return None


async def resolve_channel_latest(link_or_chat_id) -> tuple[int, str, int]:
    """
    Resolve a channel and return (chat_id, title, latest_message_id).

    Uses any warm userbot. Works for public channels without joining; private
    channels require at least one userbot to be a member.
    """
    client = _first_client()
    if client is None:
        raise UserbotError("No warm userbots available yet.")

    target = link_or_chat_id
    if isinstance(link_or_chat_id, str):
        target = _normalize_link(link_or_chat_id)
    chat = await client.get_chat(target)

    latest = 0
    async for msg in client.get_chat_history(chat.id, limit=1):
        latest = msg.id
        break

    title = chat.title or (f"@{chat.username}" if chat.username else str(chat.id))
    return chat.id, title, latest


def _natural_arrival_offsets(n: int, window_seconds: float, *, front_load: bool = True) -> list[float]:
    """
    Return `n` arrival offsets in seconds (sorted) spread across [0, window] the
    way real people trickle in rather than all at once:

      * uneven gaps - some arrivals bunch together, some have longer pauses,
        because we draw random points and sort them (never a robotic even cadence).
      * front-loaded - when front_load is set, most arrivals happen soon after
        the post with a thinning tail toward the end of the window, which is how
        real reactions/views on a fresh post actually behave.

    Every offset is <= window, so all actions finish inside the window (this is
    what makes 'custom = exactly N minutes' hold: the last one lands within N min).
    """
    if n <= 0:
        return []
    window = max(0.0, float(window_seconds))
    if window == 0.0:
        return [0.0] * n
    pts = sorted(random.random() for _ in range(n))
    if front_load:
        # p in [0,1]; p**1.7 < p, so mass shifts earlier, leaving a natural tail.
        pts = [p ** 1.7 for p in pts]
    return [round(p * window, 3) for p in pts]


async def view_post_all(chat_id: int, message_id: int, spread_seconds: float = 0.0) -> int:
    """
    Increment the view count of a post from EVERY warm userbot, but trickle the
    views in over `spread_seconds` (front-loaded, uneven gaps) so they look like
    real viewers arriving one after another instead of a single instant spike.
    Returns how many userbots successfully registered a view.
    """
    clients = [entry["client"] for entry in _POOL.values()]
    if not clients:
        return 0

    offsets = _natural_arrival_offsets(len(clients), spread_seconds)

    async def _one(client: Client, delay: float) -> bool:
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            peer = await client.resolve_peer(chat_id)
            await client.invoke(
                GetMessagesViews(peer=peer, id=[int(message_id)], increment=True)
            )
            return True
        except Exception as e:
            print(f"[!] view failed (msg {message_id}): {e.__class__.__name__}: {e}")
            return False

    results = await asyncio.gather(*(_one(c, d) for c, d in zip(clients, offsets)))
    return sum(1 for ok in results if ok)


# Cross-client dedup: the SAME post is delivered to every warm userbot that is a
# member of the channel, so with many accounts one post would fire this handler
# hundreds of times. We remember (chat_id, message_id) briefly and only let the
# first delivery dispatch; the rest return immediately. This keeps detection
# instant while avoiding a burst of redundant DB lookups per post, which matters
# once you watch 5-10+ channels with a large account pool.
_SEEN_POSTS: dict[tuple[int, int], float] = {}
_SEEN_TTL_SECONDS = 120.0


def _already_dispatched(chat_id: int, message_id: int) -> bool:
    """
    True if this (chat_id, message_id) was already handled recently. Safe on the
    single-threaded event loop: the check-and-set below has no await in between,
    so two concurrent deliveries can't both pass. Prunes expired keys opportunistically.
    """
    now = time.monotonic()
    key = (int(chat_id), int(message_id))
    if key in _SEEN_POSTS:
        return True
    _SEEN_POSTS[key] = now
    if len(_SEEN_POSTS) > 5000:
        for k, ts in list(_SEEN_POSTS.items()):
            if now - ts > _SEEN_TTL_SECONDS:
                _SEEN_POSTS.pop(k, None)
    return False


async def _on_channel_post(client: Client, message) -> None:
    """Live handler: a new post arrived in a channel/group this userbot is in."""
    chat = getattr(message, "chat", None)
    if chat is None:
        return
    # Only dispatch once per post, no matter how many userbots received it.
    if _already_dispatched(chat.id, message.id):
        return
    if _VIEW_DISPATCH is not None:
        try:
            await _VIEW_DISPATCH(chat.id, message.id)
        except Exception as e:
            print(f"[!] live view dispatch failed: {e}")
    if _REACTION_DISPATCH is not None:
        try:
            await _REACTION_DISPATCH(chat.id, message.id)
        except Exception as e:
            print(f"[!] live reaction dispatch failed: {e}")


def attach_view_handlers() -> int:
    """
    Attach the new-post handler to every warm client. Whichever userbot is a
    member of a watched channel will detect new posts instantly; the worker's
    polling loop is the fallback. Returns how many handlers were attached.
    """
    count = 0
    # Cover broadcast channels AND groups/supergroups (discussion groups, comment
    # groups) so posts in any watched chat type are detected live, not just
    # broadcast channels.
    post_filter = filters.channel | filters.group
    for entry in _POOL.values():
        client: Client = entry["client"]
        if entry.get("view_handler"):
            continue  # already attached
        handler = MessageHandler(_on_channel_post, post_filter)
        client.add_handler(handler)
        entry["view_handler"] = handler
        count += 1
    return count


# ===========================================================================
# Incoming messages: surface Telegram's service messages (login codes, notices)
# ===========================================================================

# Telegram's official service account. All system messages — login codes,
# security alerts, "new login" notices — arrive from this peer. We deliberately
# ONLY capture messages from this account: nothing the user chats with is stored,
# just Telegram's own notices, which is exactly what the panel needs to show.
TELEGRAM_SERVICE_ID = 777000


def _account_id_for_client(client: Client) -> Optional[int]:
    """Reverse-lookup which pooled account a client belongs to."""
    for acc_id, entry in _POOL.items():
        if entry.get("client") is client:
            return acc_id
    return None


async def _on_service_message(client: Client, message) -> None:
    """Live handler: a private message arrived from Telegram's service account."""
    if _MESSAGE_DISPATCH is None:
        return
    body = getattr(message, "text", None) or getattr(message, "caption", None)
    if not body:
        return
    account_id = _account_id_for_client(client)
    if account_id is None:
        return
    # message.date is a datetime; psycopg stores it directly as timestamptz.
    message_date = getattr(message, "date", None)
    try:
        await _MESSAGE_DISPATCH(account_id, str(body), int(message.id), "Telegram", message_date)
    except Exception as e:
        print(f"[!] message store failed (account {account_id}): {e}")


def attach_message_handlers() -> int:
    """
    Attach the service-message handler to every warm client so each userbot's
    incoming Telegram notices are captured live. Returns how many were attached.
    """
    count = 0
    # Only private (one-to-one) messages from Telegram's service account 777000.
    service_filter = filters.private & filters.user(TELEGRAM_SERVICE_ID)
    for entry in _POOL.values():
        client: Client = entry["client"]
        if entry.get("message_handler"):
            continue  # already attached
        handler = MessageHandler(_on_service_message, service_filter)
        client.add_handler(handler)
        entry["message_handler"] = handler
        count += 1
    return count


# ===========================================================================
# Vote: detect the most recent poll in a channel and vote / un-vote on it
# ===========================================================================

class NoPollFound(UserbotError):
    """Raised when the channel has no poll in its recent messages."""


# How many recent messages to scan when looking for the latest poll.
_POLL_SCAN_LIMIT = 100


async def detect_recent_poll(link_or_chat_id) -> dict:
    """
    Open a public/private channel and return info about its MOST RECENT poll:
      { chat_id, message_id, poll_id, question, options:[{index,text}],
        multiple_choice }

    Uses any warm userbot. For a private channel at least one userbot must be a
    member (we attempt to join from the link first).
    """
    client = _first_client()
    if client is None:
        raise UserbotError("No warm userbots available yet.")

    # Make sure the reader userbot can actually see the channel.
    try:
        chat_id = await _resolve_and_join_chat(client, str(link_or_chat_id))
    except Exception:
        target = link_or_chat_id
        if isinstance(link_or_chat_id, str):
            target = _normalize_link(link_or_chat_id)
        chat = await client.get_chat(target)
        chat_id = chat.id

    poll_msg = None
    async for msg in client.get_chat_history(chat_id, limit=_POLL_SCAN_LIMIT):
        if getattr(msg, "poll", None) is not None:
            poll_msg = msg
            break

    if poll_msg is None:
        raise NoPollFound(
            "No poll found in the recent messages of this channel. "
            "Make sure the link points to a channel that has a poll."
        )

    poll = poll_msg.poll
    options = []
    for i, opt in enumerate(poll.options):
        text = getattr(opt, "text", None) or getattr(opt, "option", "") or f"Option {i + 1}"
        options.append({"index": i, "text": str(text)})

    return {
        "chat_id": int(chat_id),
        "message_id": int(poll_msg.id),
        "poll_id": str(getattr(poll, "id", "") or ""),
        "question": getattr(poll, "question", None),
        "options": options,
        "multiple_choice": bool(getattr(poll, "allows_multiple_answers", False)),
    }


async def vote_on_poll(
    account_id: int,
    api_id: int,
    api_hash: str,
    session_string: str,
    chat_link: str,
    chat_id: Optional[int],
    message_id: int,
    option_index: int,
) -> None:
    """Make one userbot vote for `option_index` on a poll (joins the chat first)."""
    entry = await _ensure_online(account_id, api_id, api_hash, session_string)
    client: Client = entry["client"]

    # Ensure this userbot is a member so it is allowed to vote.
    resolved = chat_id
    try:
        joined = await _resolve_and_join_chat(client, chat_link or str(chat_id))
        resolved = joined or chat_id
    except Exception:
        resolved = chat_id

    await client.vote_poll(resolved, int(message_id), int(option_index))


async def retract_poll_vote(
    account_id: int,
    api_id: int,
    api_hash: str,
    session_string: str,
    chat_link: str,
    chat_id: Optional[int],
    message_id: int,
) -> None:
    """
    Remove this userbot's vote from a poll. Pyrogram's high-level vote_poll
    cannot send an empty selection, so we use the raw messages.SendVote with no
    options, which retracts the vote.
    """
    from pyrogram.raw.functions.messages import SendVote

    entry = await _ensure_online(account_id, api_id, api_hash, session_string)
    client: Client = entry["client"]

    peer = await client.resolve_peer(chat_id if chat_id is not None else _normalize_link(chat_link))
    await client.invoke(SendVote(peer=peer, msg_id=int(message_id), options=[]))


# ===========================================================================
# Reactions: react to a post from many userbots, spread over a time window so
# it looks like real users reacting one by one.
# ===========================================================================

# Telegram RPC error fragments that mean reactions are STRUCTURALLY impossible on
# this post for EVERY userbot (reactions disabled, restricted to a set of emojis
# that doesn't include ours, no permission, post deleted, channel private, etc.),
# as opposed to a transient hiccup on a single account. When we see these we can
# safely stop trying the rest of the pool instead of firing a guaranteed-to-fail
# call at every single userbot.
_REACTIONS_BLOCKED_MARKERS = (
    "REACTION_INVALID",
    "REACTION_EMPTY",
    "REACTIONS_ALL_DISABLED",
    "CHAT_SEND_REACTIONS_FORBIDDEN",
    "CHAT_ADMIN_REQUIRED",
    "CHAT_WRITE_FORBIDDEN",
    "CHANNEL_PRIVATE",
    "USER_BANNED_IN_CHANNEL",
    "MSG_ID_INVALID",
    "MESSAGE_ID_INVALID",
    "PEER_ID_INVALID",
)


def _reaction_error_kind(exc: Exception) -> str:
    """
    Classify a failed reaction as 'blocked' (the whole channel/post will reject
    reactions from anyone with our emoji set) vs 'transient' (retryable or
    specific to one account). Used to decide whether to skip the rest of the pool.
    """
    text = f"{getattr(exc, 'ID', '')} {getattr(exc, 'MESSAGE', '')} {exc}".upper()
    for marker in _REACTIONS_BLOCKED_MARKERS:
        if marker in text:
            return "blocked"
    return "transient"


async def _react_once(client: Client, chat_id: int, message_id: int, emojis: list[str]) -> str:
    """
    Make ONE userbot react with a random emoji from `emojis`. If the channel does
    not allow that emoji on this post, quietly try the next one.

    NEVER raises - a rejected reaction can never crash the worker. Returns:
      "ok"        - a reaction landed
      "blocked"   - every emoji was rejected for a permission/config reason, so
                    no other userbot will be able to react to this post either
      "transient" - failed for a retryable / account-specific reason
    """
    last_kind = "transient"
    for emoji in random.sample(emojis, len(emojis)):
        try:
            await client.send_reaction(chat_id, int(message_id), emoji=emoji)
            return "ok"
        except Exception as e:  # noqa: BLE001 - one bad react must never abort the run
            # A different emoji might still be accepted, so remember the verdict
            # and keep trying the rest; only the final outcome matters.
            last_kind = _reaction_error_kind(e)
            continue
    return last_kind


async def react_post_scheduled(
    chat_id: int,
    message_id: int,
    emojis: list[str],
    window_seconds: float,
    react_min: int = 0,
    react_max: int = 0,
    shard_index: int = 0,
    shard_count: int = 1,
) -> int:
    """
    React to a single post from the warm userbots, staggering each userbot's
    reaction at a random offset inside [0, window_seconds] so the reactions don't
    all land at once. All reactions are guaranteed to complete within the window.

    "Below to high" amount: when react_max > 0, only a RANDOM number of userbots
    in [react_min, react_max] reacts to this post (a fresh random subset each
    time, capped at the pool size). When react_max is 0, every warm userbot
    reacts.

    Sharding: this handler runs once PER shard (each shard owns a slice of the
    userbots). The [react_min, react_max] range is a GLOBAL target for the whole
    post, so we must NOT re-roll it independently on every shard - otherwise a
    channel split across N shards would get up to N x the requested reactions
    (i.e. effectively every userbot reacts). Instead we roll the total ONCE using
    a per-post deterministic seed (so every shard agrees on the same number) and
    then hand this shard only its fair slice of that total.

    Returns how many userbots successfully reacted (emojis the channel rejects
    are skipped, so the count can be lower than the number chosen).
    """
    clients = [entry["client"] for entry in _POOL.values()]
    if not clients or not emojis:
        return 0

    # Pick a "below to high" amount of userbots for this specific post.
    lo = max(0, int(react_min or 0))
    hi = max(0, int(react_max or 0))
    if hi > 0:
        if lo > hi:
            lo, hi = hi, lo
        shards = max(1, int(shard_count or 1))
        idx = min(max(0, int(shard_index or 0)), shards - 1)

        # Roll the GLOBAL total once, identically on every shard, seeded by the
        # post so all shards compute the same number without talking to each other.
        rng = random.Random(f"{chat_id}:{message_id}:{lo}:{hi}")
        total_count = rng.randint(lo, hi)
        if total_count <= 0:
            return 0

        # Split the global total evenly across shards; the first `remainder`
        # shards take one extra so the per-shard shares sum EXACTLY to total_count.
        base, remainder = divmod(total_count, shards)
        my_count = base + (1 if idx < remainder else 0)

        # Cap at this shard's local pool (shares are only ever short, never over,
        # which keeps the global total <= the requested "high").
        my_count = min(my_count, len(clients))
        if my_count <= 0:
            return 0
        clients = random.sample(clients, my_count)

    # ---- Probe phase -------------------------------------------------------
    # Before firing at the whole pool, let a couple of userbots test the post.
    # If reactions are not allowed here (disabled, restricted emoji set, no
    # permission, deleted post, private channel, ...) the probes come back
    # "blocked" and we skip the rest of the pool quietly - no crash, no wasted
    # calls hammering a post that will reject everyone.
    probe_n = min(2, len(clients))
    probe_clients = clients[:probe_n]
    rest_clients = clients[probe_n:]

    probe_results = await asyncio.gather(
        *(_react_once(c, chat_id, message_id, emojis) for c in probe_clients),
        return_exceptions=True,
    )
    success = sum(1 for r in probe_results if r == "ok")
    blocked = sum(1 for r in probe_results if r == "blocked")

    # Every probe was blocked and none succeeded -> reactions are impossible on
    # this post for anyone. Stop here instead of trying the remaining userbots.
    if probe_n > 0 and success == 0 and blocked == probe_n:
        print(
            f"[react] skipping post {chat_id}/{message_id}: reactions not allowed "
            f"(all {probe_n} probe userbot(s) blocked); remaining {len(rest_clients)} skipped"
        )
        return 0

    if not rest_clients:
        return success

    # ---- Fan out to the rest of the pool -----------------------------------
    # Front-loaded, uneven arrival times inside the window: a burst of early
    # reactions right after the post, then a thinning tail - just like real users.
    offsets = _natural_arrival_offsets(len(rest_clients), window_seconds)

    async def _scheduled(client: Client, delay: float) -> str:
        if delay > 0:
            await asyncio.sleep(delay)
        return await _react_once(client, chat_id, message_id, emojis)

    # return_exceptions=True: even an unexpected error on one userbot can never
    # bubble up and take down the job / worker.
    results = await asyncio.gather(
        *(_scheduled(c, d) for c, d in zip(rest_clients, offsets)),
        return_exceptions=True,
    )
    return success + sum(1 for r in results if r == "ok")


# ===========================================================================
# Profile editing: change one account's name / username / profile photo.
# ===========================================================================

def _username_candidates(base: str) -> list[str]:
    """
    Build a list of username candidates from a seed. Telegram usernames must be
    5-32 chars, start with a letter, and contain only letters/digits/underscore.
    We try the clean base first, then progressively longer random-digit suffixes
    so collisions get resolved with a unique handle.
    """
    import random

    seed = "".join(ch for ch in (base or "").lower() if ch.isalnum())
    seed = seed.lstrip("0123456789")  # must start with a letter
    if not seed:
        seed = "user"
    seed = seed[:32]

    candidates: list[str] = []

    def _add(u: str) -> None:
        u = u[:32]
        if 5 <= len(u) <= 32 and u not in candidates:
            candidates.append(u)

    # Bare base only if already long enough on its own.
    if len(seed) >= 5:
        _add(seed)

    # Random numeric suffixes with widening range for more uniqueness attempts.
    for digits in (2, 3, 4, 5):
        for _ in range(6):
            suffix = str(random.randint(0, 10 ** digits - 1)).zfill(digits)
            _add(f"{seed}{suffix}")

    return candidates


async def _flood_retry(make_coro, *, what: str, attempts: int = 3, inline_max: int = 30):
    """
    Run a Telegram call, handling FloodWait rate limits gracefully.

    `make_coro` is a zero-arg callable that returns a FRESH awaitable each time so
    we can re-issue the request after sleeping.

    Strategy tuned for bulk (500+ account) runs:
      - SHORT floods (<= inline_max seconds): sleep it out and retry inline, up to
        `attempts` times. Cheap, avoids queue churn.
      - LONG floods (> inline_max): raise FloodWaitError carrying the wait so the
        worker RESCHEDULES the whole job to run later, freeing this slot to make
        progress on other accounts instead of blocking for minutes.
    """
    from pyrogram.errors import FloodWait

    for i in range(attempts):
        try:
            return await make_coro()
        except FloodWait as e:
            wait = int(getattr(e, "value", 0) or 0)
            if wait > inline_max or i == attempts - 1:
                raise FloodWaitError(wait, what)
            print(f"[flood] {what}: waiting {wait}s then retrying ({i + 1}/{attempts - 1})...")
            await asyncio.sleep(wait + random.uniform(1.0, 3.0))
    raise FloodWaitError(0, what)


async def update_profile(
    account_id: int,
    api_id: int,
    api_hash: str,
    session_string: str,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    username: Optional[str] = None,
    username_base: Optional[str] = None,
    auto_username: bool = False,
    photo_bytes: Optional[bytes] = None,
) -> dict:
    """
    Apply profile changes to a single userbot account. Any argument left as None
    (or empty) is skipped, so you can change just the name, just the photo, etc.

    Username handling:
      - If `auto_username` is set, a username is generated from `username_base`
        (falling back to the name). We try candidate handles until one sticks,
        so "already taken" collisions are resolved automatically.
      - Otherwise, if an explicit `username` is given, we try just that one.

    Returns a dict describing what changed (and the final username, if set).
    Raises UserbotError with a friendly message on unrecoverable failures.
    """
    import io

    from pyrogram.errors import (
        UsernameOccupied,
        UsernameInvalid,
        UsernameNotModified,
        BadRequest,
    )

    entry = await _ensure_online(account_id, api_id, api_hash, session_string)
    client: Client = entry["client"]

    changed: list[str] = []
    final_username: Optional[str] = None

    # --- name (first / last) ---
    if (first_name and first_name.strip()) or (last_name and last_name.strip()):
        me = await client.get_me()
        new_first = first_name.strip() if (first_name and first_name.strip()) else (me.first_name or "")
        # An empty last name is intentional (list entry had no surname), so only
        # keep the existing surname when last_name was not supplied at all.
        new_last = last_name.strip() if last_name is not None else (me.last_name or "")
        await _flood_retry(
            lambda: client.update_profile(first_name=new_first, last_name=new_last),
            what="name update",
        )
        changed.append("name")

    # --- username ---
    if auto_username:
        seed = username_base or " ".join(x for x in [first_name, last_name] if x)
        candidates = _username_candidates(seed)
        last_err: Optional[str] = None
        for cand in candidates:
            try:
                await _flood_retry(lambda c=cand: client.set_username(c), what="setting username")
                final_username = cand
                changed.append("username")
                break
            except UsernameNotModified:
                final_username = cand
                changed.append("username")
                break
            except (UsernameOccupied, UsernameInvalid):
                # Already taken / not a valid handle -> just try the next one.
                last_err = cand
                continue
            except BadRequest as e:
                # Covers USERNAME_PURCHASE_AVAILABLE (reserved for sale on
                # fragment.com) and any other "can't use this handle" 400s.
                # None of these are fatal for us: move on to the next candidate.
                last_err = f"{cand} ({e})"
                continue
        if final_username is None:
            raise UserbotError(
                f"Could not find a free username from '{seed}' after several tries."
            )
    elif username and username.strip():
        uname = username.strip().lstrip("@")
        try:
            await _flood_retry(lambda: client.set_username(uname), what=f"setting @{uname}")
            final_username = uname
            changed.append("username")
        except UsernameNotModified:
            final_username = uname
            changed.append("username")  # already set to this value; treat as success
        except UsernameOccupied:
            raise UserbotError(f"Username @{uname} is already taken.")
        except UsernameInvalid:
            raise UserbotError(f"Username @{uname} is invalid.")
        except BadRequest as e:
            # e.g. USERNAME_PURCHASE_AVAILABLE (reserved for sale on fragment.com).
            if "PURCHASE_AVAILABLE" in str(e):
                raise UserbotError(
                    f"Username @{uname} is reserved for purchase on fragment.com. Pick another."
                )
            raise UserbotError(f"Could not set @{uname}: {e}")

    # --- profile photo ---
    if photo_bytes:
        bio = io.BytesIO(photo_bytes)
        bio.name = "profile.jpg"

        def _do_photo():
            bio.seek(0)  # rewind so a retry after FloodWait re-reads the full image
            return client.set_profile_photo(photo=bio)

        await _flood_retry(_do_photo, what="photo update")
        changed.append("photo")

    return {"changed": changed, "username": final_username}
