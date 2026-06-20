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

from typing import Optional

from pyrogram import Client
from pyrogram.errors import SessionPasswordNeeded, PhoneCodeInvalid, PhoneCodeExpired
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream


class LoginNeeds2FA(Exception):
    """Raised when the account has two-factor auth and we need the password."""


class UserbotError(Exception):
    pass


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

    # 2) Join the active group call (listen-only: both streams ignored).
    await calls.play(
        chat_id,
        MediaStream(
            "input.raw",
            audio_flags=MediaStream.Flags.IGNORE,
            video_flags=MediaStream.Flags.IGNORE,
        ),
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
