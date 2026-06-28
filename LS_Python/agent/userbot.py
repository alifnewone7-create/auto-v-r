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
from typing import Optional

from pyrogram import Client, filters
from pyrogram.errors import (
    SessionPasswordNeeded,
    PhoneCodeInvalid,
    PhoneCodeExpired,
    ChatAdminRequired,
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


# In-memory pool of live userbots, keyed by account_id.
# { account_id: {"client": Client, "calls": PyTgCalls} }
_POOL: dict[int, dict] = {}

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
    return _POOL[account_id]


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


async def join_livestream(
    account_id: int, api_id: int, api_hash: str, session_string: str, chat_link: str
) -> None:
    """
    Make the userbot join the chat (if needed) and then its active live stream /
    video chat in LISTEN-ONLY mode (we send no audio/video).
    """
    entry = await _ensure_online(account_id, api_id, api_hash, session_string)
    client: Client = entry["client"]
    calls: PyTgCalls = entry["calls"]

    # 1) Resolve + join the chat so the userbot is a member.
    chat_id = await _resolve_and_join_chat(client, chat_link)

    # 2) Make sure a live stream / video chat is actually running. If it is NOT,
    #    pytgcalls would try phone.CreateGroupCall, which needs admin rights and
    #    fails with CHAT_ADMIN_REQUIRED. We want to JOIN an existing stream only,
    #    never create one, so we check first and report a clear error.
    if not await _has_active_group_call(client, chat_id):
        raise NoActiveLivestream(
            "No live stream is currently running in this chat. "
            "Start the live stream/video chat first, then add the link."
        )

    # 3) Join the active group call (listen-only: both streams ignored).
    try:
        await calls.play(
            chat_id,
            MediaStream(
                "input.raw",
                audio_flags=MediaStream.Flags.IGNORE,
                video_flags=MediaStream.Flags.IGNORE,
            ),
        )
    except ChatAdminRequired:
        # Race: the live stream ended between our check and the join attempt.
        raise NoActiveLivestream(
            "No live stream is currently running in this chat. "
            "Start the live stream/video chat first, then add the link."
        )


async def leave_livestream(account_id: int, chat_link: str) -> None:
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
# Live View: auto-view future channel posts with every logged-in userbot
# ===========================================================================

# Set by the worker. Called as: await _VIEW_DISPATCH(chat_id, message_id)
_VIEW_DISPATCH = None
# Set by the worker. Called as: await _REACTION_DISPATCH(chat_id, message_id)
_REACTION_DISPATCH = None


def set_view_dispatch(callback) -> None:
    """Register the worker callback that turns a detected post into view jobs."""
    global _VIEW_DISPATCH
    _VIEW_DISPATCH = callback


def set_reaction_dispatch(callback) -> None:
    """Register the worker callback that turns a detected post into reaction jobs."""
    global _REACTION_DISPATCH
    _REACTION_DISPATCH = callback


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


async def view_post_all(chat_id: int, message_id: int) -> int:
    """
    Increment the view count of a post from EVERY warm userbot concurrently.
    Returns how many userbots successfully registered a view.
    """
    clients = [entry["client"] for entry in _POOL.values()]
    if not clients:
        return 0

    async def _one(client: Client) -> bool:
        try:
            peer = await client.resolve_peer(chat_id)
            await client.invoke(
                GetMessagesViews(peer=peer, id=[int(message_id)], increment=True)
            )
            return True
        except Exception as e:
            print(f"[!] view failed (msg {message_id}): {e.__class__.__name__}: {e}")
            return False

    results = await asyncio.gather(*(_one(c) for c in clients))
    return sum(1 for ok in results if ok)


async def _on_channel_post(client: Client, message) -> None:
    """Live handler: a new post arrived in a channel this userbot is in."""
    chat = getattr(message, "chat", None)
    if chat is None:
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
    for entry in _POOL.values():
        client: Client = entry["client"]
        if entry.get("view_handler"):
            continue  # already attached
        handler = MessageHandler(_on_channel_post, filters.channel)
        client.add_handler(handler)
        entry["view_handler"] = handler
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

import random  # noqa: E402  (local to the reaction feature)


async def _react_once(client: Client, chat_id: int, message_id: int, emojis: list[str]) -> bool:
    """
    Make ONE userbot react with a random emoji from `emojis`. If the channel does
    not allow that emoji on this post, quietly try the next one. If none are
    allowed, skip without raising (returns False). Returns True on success.
    """
    for emoji in random.sample(emojis, len(emojis)):
        try:
            await client.send_reaction(chat_id, int(message_id), emoji=emoji)
            return True
        except Exception:
            # ReactionInvalid / not allowed / transient -> try the next emoji.
            continue
    return False


async def react_post_scheduled(
    chat_id: int,
    message_id: int,
    emojis: list[str],
    window_seconds: float,
) -> int:
    """
    React to a single post from EVERY warm userbot, but stagger each userbot's
    reaction at a random offset inside [0, window_seconds] so the reactions don't
    all land at once. All reactions are guaranteed to complete within the window.

    Returns how many userbots successfully reacted (emojis the channel rejects
    are skipped, so the count can be lower than the number of userbots).
    """
    clients = [entry["client"] for entry in _POOL.values()]
    if not clients or not emojis:
        return 0

    window = max(0.0, float(window_seconds))
    # Keep the very last reactions just inside the window, never after it.
    span = window * 0.97

    async def _scheduled(client: Client) -> bool:
        if span > 0:
            await asyncio.sleep(random.uniform(0, span))
        return await _react_once(client, chat_id, message_id, emojis)

    results = await asyncio.gather(*(_scheduled(c) for c in clients))
    return sum(1 for ok in results if ok)
