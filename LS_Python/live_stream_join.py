"""
Telegram Userbot - Live Stream (Video Chat) Auto Join
======================================================

Ei script ekta Telegram channel/group-er link nibe, prothome oi chat-e
JOIN korbe (jodi member na thake), tarpor oi chat-e cholmaan
LIVE STREAM / VIDEO CHAT (group call)-e LISTEN-ONLY mode-e join korbe.

Library:
    - Pyrogram  -> Telegram client (login, chat join)
    - py-tgcalls -> Group call / live stream-e join korar jonno

NOTE (Bangla):
    Telegram-e alada kono "live stream link" nei. Jeta live stream,
    seta hocche kono channel/group-er Video Chat (group call). Tai
    apni channel/group-er LINK ba USERNAME diben, script seita diye
    age chat-e dhukbe tarpor oi chat-er active stream-e join korbe.
"""

import asyncio
import sys

# ---------------------------------------------------------------------------
# EVENT LOOP FIX (Python 3.12+ / 3.14)
# ---------------------------------------------------------------------------
# Python 3.12 theke `asyncio.get_event_loop()` MainThread-e kono loop na thakle
# RuntimeError dey. Pyrogram import howar somoy ei function call kore, tai
# import-ei crash kore ("There is no current event loop in thread 'MainThread'").
# Niche ekta loop banaye set kore dile import-time error chole jay.
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

# WARNING: py-tgcalls (live stream join) ekhono Python 3.13/3.14 e thik moto
# kaj nao korte pare. Stable result-er jonno Python 3.11 ba 3.12 use korun.
if sys.version_info >= (3, 13):
    print(
        "[!] Sotorko: Apni Python "
        f"{sys.version_info.major}.{sys.version_info.minor} use korchen. "
        "py-tgcalls Python 3.11/3.12 te shobcheye stable. "
        "Live stream join na hole Python 3.11 install kore cholan.\n"
    )

from pyrogram import Client
from pyrogram.errors import (
    UserAlreadyParticipant,
    InviteHashExpired,
    FloodWait,
)
from pytgcalls import PyTgCalls
from pytgcalls.types import MediaStream, AudioQuality

# ---------------------------------------------------------------------------
# API CREDENTIALS
# ---------------------------------------------------------------------------
# https://my.telegram.org -> API development tools theke API_ID o API_HASH nin.
# Niche apnar nijer value boshiye din.
API_ID = 36133167                                  # <-- apnar API ID
API_HASH = "1bcd447993d473593424ec00e31d3439"      # <-- apnar API HASH

# Session file name. Prothom barer login-er por ei file-e session save thakbe,
# tai porer bar ar phone number/OTP lagbe na.
SESSION_NAME = "ls_userbot"

# ---------------------------------------------------------------------------
# CLIENT SETUP
# ---------------------------------------------------------------------------
# Phone number diye interactive login: run korle terminal-e phone number o
# OTP (and proyojone 2FA password) chaibe.
app = Client(
    SESSION_NAME,
    api_id=API_ID,
    api_hash=API_HASH,
)

# py-tgcalls instance, Pyrogram client-er upor cholbe.
call_py = PyTgCalls(app)


# ---------------------------------------------------------------------------
# HELPER: chat-e join kora
# ---------------------------------------------------------------------------
async def ensure_joined(link: str):
    """
    Channel/group link ba username diye chat-e join kore.
    Return kore chat-er id (jeta diye stream-e join korbo).
    """
    link = link.strip()

    # Invite link (t.me/+xxxx ba t.me/joinchat/xxxx) handle kora
    is_invite = ("t.me/+" in link) or ("joinchat" in link)

    try:
        if is_invite:
            # Private invite link diye join
            chat = await app.join_chat(link)
            print(f"[+] Private chat-e join holo: {chat.title}")
            return chat.id
        else:
            # Public username/link (@name ba t.me/name) diye join chesta
            try:
                chat = await app.join_chat(link)
                print(f"[+] Chat-e join holo: {chat.title}")
                return chat.id
            except UserAlreadyParticipant:
                pass

            # Already member thakle just chat info ber kori
            chat = await app.get_chat(link)
            print(f"[i] Age theke member: {chat.title}")
            return chat.id

    except UserAlreadyParticipant:
        chat = await app.get_chat(link)
        print(f"[i] Age theke member: {chat.title}")
        return chat.id
    except InviteHashExpired:
        print("[!] Invite link expire kore geche / invalid.")
        return None
    except FloodWait as e:
        print(f"[!] FloodWait: {e.value} second wait korte hobe.")
        return None
    except Exception as e:
        print(f"[!] Chat-e join korte error: {e}")
        return None


# ---------------------------------------------------------------------------
# HELPER: live stream / video chat-e LISTEN-ONLY join
# ---------------------------------------------------------------------------
async def join_live_stream(chat_id: int):
    """
    Chat-er cholmaan video chat (group call)-e listen-only mode-e join kore.
    Listen-only mane: kono audio/video pathabo na, sudhu shune/dekhe.
    """
    try:
        # MediaStream-e silent/empty input diye listen-only join kora hoy.
        # AudioQuality kom rakha holo karon amra kichu pathacchi na.
        await call_py.play(
            chat_id,
            MediaStream(
                "input.raw",  # placeholder; listen-only te real file lage na
                audio_parameters=AudioQuality.STUDIO,
                video_flags=MediaStream.Flags.IGNORE,  # video off
                audio_flags=MediaStream.Flags.IGNORE,  # audio off -> listen only
            ),
        )
        print("[+] Live stream-e (video chat) join holo - LISTEN ONLY mode.")
        return True
    except Exception as e:
        print(f"[!] Live stream-e join korte error: {e}")
        print("    -> Hoyto oi chat-e ekhon kono live stream/video chat chalu nei.")
        return False


# ---------------------------------------------------------------------------
# MAIN FLOW
# ---------------------------------------------------------------------------
async def main():
    await app.start()
    await call_py.start()

    me = await app.get_me()
    print(f"\n[i] Login holo: {me.first_name} (@{me.username})\n")

    print("=" * 60)
    print(" Telegram Live Stream Auto Join (Listen-Only)")
    print("=" * 60)
    print(" Channel/Group-er LINK ba USERNAME din. Bot age oi chat-e")
    print(" join korbe, tarpor oi chat-er cholmaan live stream-e dhukbe.")
    print(" Ber hote 'exit' likhun.")
    print("=" * 60)

    while True:
        try:
            link = input("\n>> Channel/Group link/username: ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not link:
            continue
        if link.lower() in ("exit", "quit", "q"):
            break

        # Step 1: chat-e join
        chat_id = await ensure_joined(link)
        if chat_id is None:
            continue

        # Step 2: oi chat-er live stream-e listen-only join
        await join_live_stream(chat_id)

    print("\n[i] Stream theke ber hocchi...")
    try:
        await call_py.leave_call(chat_id)
    except Exception:
        pass
    await app.stop()
    print("[i] Bondho holo. Bye!")


if __name__ == "__main__":
    asyncio.run(main())
