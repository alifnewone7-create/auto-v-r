"""
Iamhear userbot agent - main worker loop.

Run this on your local PC or a VPS. It connects to the SAME Neon database the
website uses, polls the `jobs` table, and executes each job:

  create_app          -> log into my.telegram.org, create the app, store api_id/hash
  submit_mtproto_code -> finish my.telegram.org login with the code you typed
  send_login_code     -> send a userbot login code to the phone
  submit_login_code   -> finish userbot login (+2FA), store the session string
  join_livestream     -> join a chat's live stream (listen-only)
  leave_livestream    -> leave the live stream

Start it with:  python -m agent.worker      (from the LS_Python folder)
"""

from __future__ import annotations

# --- event loop fix (Python 3.12+), must run before pyrogram import in userbot ---
import asyncio

try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

import os
import socket
import time
import uuid

from dotenv import load_dotenv

load_dotenv()

from agent import db
from agent import mtproto_app
from agent import userbot

POLL_SECONDS = float(os.environ.get("AGENT_POLL_SECONDS", "3"))
# How many queued jobs to claim and run concurrently per loop. Raise this if you
# have many userbots (e.g. 100) so they all join in one parallel batch.
BATCH_SIZE = int(os.environ.get("AGENT_BATCH_SIZE", "100"))
# How often to poll watched channels for new posts (live-handler fallback).
VIEW_POLL_SECONDS = float(os.environ.get("AGENT_VIEW_POLL_SECONDS", "5"))
# Safety cap: never enqueue more than this many posts at once from one detection
# (prevents a huge backfill if last_seen somehow falls far behind).
VIEW_MAX_BACKFILL = int(os.environ.get("AGENT_VIEW_MAX_BACKFILL", "30"))
AGENT_ID = os.environ.get("AGENT_ID") or f"agent-{uuid.uuid4().hex[:8]}"
HOSTNAME = socket.gethostname()


# ---------------------------------------------------------------------------
# Job handlers. Each returns a dict that gets stored as the job result.
# ---------------------------------------------------------------------------

async def handle_create_app(job: dict) -> dict:
    """
    Log into my.telegram.org and request the login code. We CANNOT finish here
    because the code arrives in the Telegram app - so we send the code, save the
    random_hash, and move the account to 'api_code' so the website shows an input.
    """
    account_id = job["account_id"]
    acc = db.get_account(account_id)
    phone = acc["phone_number"]

    random_hash = mtproto_app.send_login_code(phone)
    # Persist the random_hash in its own column so submit_mtproto_code can use it.
    db.update_account(account_id, status="api_code", last_error=None, mtproto_hash=random_hash)
    return {"stage": "code_sent", "message": "my.telegram.org code sent to the Telegram app."}


async def handle_submit_mtproto_code(job: dict) -> dict:
    """Finish my.telegram.org login with the code, then create the app."""
    account_id = job["account_id"]
    acc = db.get_account(account_id)
    phone = acc["phone_number"]
    code = job["payload"].get("code", "").strip()

    random_hash = acc.get("mtproto_hash")
    if not random_hash:
        raise RuntimeError("Missing my.telegram.org session state. Re-add the account.")

    cookies = mtproto_app.login(phone, random_hash, code)
    api_id, api_hash = mtproto_app.get_or_create_app(
        cookies, acc["app_title"], acc["short_name"]
    )

    db.update_account(
        account_id,
        api_id=api_id,
        api_hash=api_hash,
        mtproto_hash=None,  # clear the transient hash
        status="api_collected",
        last_error=None,
    )
    return {"stage": "api_collected", "api_id": api_id}


async def handle_send_login_code(job: dict) -> dict:
    """Send a userbot login code to the phone using the collected api_id/hash."""
    account_id = job["account_id"]
    acc = db.get_account(account_id)

    session, code_hash = await userbot.begin_login(
        int(acc["api_id"]), acc["api_hash"], acc["phone_number"]
    )
    # Persist the partial session + code hash for phase 2 (own columns).
    db.update_account(
        account_id,
        session_string=session,
        login_hash=code_hash,
        last_error=None,
        status="login_code",
    )
    return {"stage": "login_code_sent"}


async def handle_submit_login_code(job: dict) -> dict:
    """Finish userbot login (+2FA), store the final session string."""
    account_id = job["account_id"]
    acc = db.get_account(account_id)
    code = job["payload"].get("code", "").strip()
    password = job["payload"].get("password")

    phone_code_hash = acc.get("login_hash")
    if not phone_code_hash:
        raise RuntimeError("Missing login code hash. Click Verify again to resend the code.")

    try:
        final_session = await userbot.complete_login(
            int(acc["api_id"]),
            acc["api_hash"],
            acc["phone_number"],
            acc["session_string"],
            phone_code_hash,
            code,
            password,
        )
    except userbot.LoginNeeds2FA:
        db.update_account(account_id, status="login_2fa", two_factor_required=True,
                          last_error=None)
        return {"stage": "needs_2fa"}

    db.update_account(
        account_id,
        session_string=final_session,
        login_hash=None,
        status="logged_in",
        last_error=None,
    )
    return {"stage": "logged_in"}


async def handle_join_livestream(job: dict) -> dict:
    account_id = job["account_id"]
    target_id = job["payload"]["target_id"]
    chat_link = job["payload"]["chat_link"]
    acc = db.get_account(account_id)

    try:
        await userbot.join_livestream(
            account_id, int(acc["api_id"]), acc["api_hash"], acc["session_string"], chat_link
        )
        db.set_participant(target_id, account_id, "joined", None)
    except Exception as e:
        db.set_participant(target_id, account_id, "failed", str(e)[:500])
        db.recount_livestream(target_id)
        raise
    db.recount_livestream(target_id)
    return {"stage": "joined", "target_id": target_id}


async def handle_leave_livestream(job: dict) -> dict:
    account_id = job["account_id"]
    target_id = job["payload"]["target_id"]
    chat_link = job["payload"].get("chat_link", "")
    await userbot.leave_livestream(account_id, chat_link)
    db.set_participant(target_id, account_id, "left", None)
    db.recount_livestream(target_id)
    return {"stage": "left", "target_id": target_id}


async def handle_view_post(job: dict) -> dict:
    """
    View a single channel post from EVERY warm userbot. One of these jobs is
    queued per new post; it fans out across the whole pool concurrently.
    """
    payload = job["payload"]
    chat_id = int(payload["chat_id"])
    message_id = int(payload["message_id"])
    target_id = payload.get("target_id")

    count = await userbot.view_post_all(chat_id, message_id)
    if target_id:
        db.bump_view_sent(int(target_id), count)
    return {"stage": "viewed", "views": count, "message_id": message_id}


HANDLERS = {
    "create_app": handle_create_app,
    "submit_mtproto_code": handle_submit_mtproto_code,
    "send_login_code": handle_send_login_code,
    "submit_login_code": handle_submit_login_code,
    "join_livestream": handle_join_livestream,
    "leave_livestream": handle_leave_livestream,
    "view_post": handle_view_post,
}

# Jobs that are part of the login / auth flow. ONLY these may flip an account
# into the 'failed' state (which makes the website ask for re-login). A livestream
# join/leave failure must NEVER log the userbot out - the account is still valid.
AUTH_JOB_TYPES = {
    "create_app",
    "submit_mtproto_code",
    "send_login_code",
    "submit_login_code",
}


async def process_one(job: dict) -> None:
    handler = HANDLERS.get(job["type"])
    if not handler:
        db.fail_job(job["id"], f"Unknown job type: {job['type']}")
        return
    try:
        result = await handler(job)
        db.finish_job(job["id"], result)
        print(f"[OK] job #{job['id']} {job['type']} -> {result.get('stage', 'done')}")
    except Exception as e:
        db.fail_job(job["id"], str(e))
        # Only auth/login jobs may mark the account as failed. A livestream
        # join/leave error keeps the account logged in so the website does not
        # wrongly ask the user to log the userbot in again.
        if job.get("account_id") and job["type"] in AUTH_JOB_TYPES:
            db.set_account_status(job["account_id"], "failed", str(e)[:500])
        print(f"[FAIL] job #{job['id']} {job['type']}: {e}")


async def prewarm_accounts() -> None:
    """Connect all logged-in userbots at startup so the first joins are fast."""
    try:
        accounts = db.query(
            """
            SELECT id, api_id, api_hash, session_string
            FROM telegram_accounts
            WHERE status = 'logged_in'
              AND api_id IS NOT NULL
              AND api_hash IS NOT NULL
              AND session_string IS NOT NULL
            """
        )
    except Exception as e:
        print(f"[!] prewarm query failed: {e}")
        return
    if not accounts:
        return
    print(f"[i] Pre-warming {len(accounts)} logged-in userbot(s)...")
    warmed = await userbot.prewarm(accounts)
    print(f"[i] {warmed}/{len(accounts)} userbot(s) connected and ready.\n")


async def dispatch_views_for_target(target_id: int, chat_id: int, latest_id: int) -> None:
    """
    Atomically claim the new post range and queue one view_post job per post.
    Safe to call from both the polling loop and the live handler - claim_view_advance
    guarantees each post is only dispatched once.
    """
    old = db.claim_view_advance(target_id, latest_id)
    if old is None:
        return  # already handled by the other detection path
    start = max(int(old) + 1, latest_id - VIEW_MAX_BACKFILL + 1)
    post_ids = list(range(start, latest_id + 1))
    if not post_ids:
        return
    for mid in post_ids:
        db.enqueue_view_job(chat_id, mid, target_id)
    db.bump_view_posts(target_id, len(post_ids))
    print(f"[view] target {target_id}: queued {len(post_ids)} new post(s) up to #{latest_id}")


async def live_view_dispatch(chat_id: int, message_id: int) -> None:
    """Live-handler callback: a watched channel just got a new post."""
    target = db.get_view_target_by_chat(chat_id)
    # Skip until the baseline is set by the polling loop (honors future-only).
    if not target or target["status"] != "active" or target["last_seen_message_id"] == 0:
        return
    await dispatch_views_for_target(target["id"], chat_id, message_id)


async def poll_view_targets() -> None:
    """
    Fallback detector: for each active channel, look up the latest post id and
    queue views for anything new. Also resolves chat_id/title on first sight and
    sets the future-only baseline for freshly added channels.
    """
    try:
        targets = db.get_active_view_targets()
    except Exception as e:
        print(f"[!] view targets query failed: {e}")
        return

    for t in targets:
        try:
            ref = t["chat_id"] if t["chat_id"] is not None else t["channel_link"]
            chat_id, title, latest = await userbot.resolve_channel_latest(ref)

            if t["chat_id"] is None or not t["title"]:
                db.set_view_target_meta(t["id"], chat_id, title)

            if t["last_seen_message_id"] == 0:
                # New channel: start the cutoff at the current latest, view nothing old.
                db.init_view_baseline(t["id"], latest)
                continue

            await dispatch_views_for_target(t["id"], chat_id, latest)
        except userbot.UserbotError:
            # No warm userbots yet - try again next cycle, don't spam errors.
            return
        except Exception as e:
            db.set_view_target_error(t["id"], str(e)[:500])
            print(f"[!] view poll failed for target {t['id']}: {e}")


async def main() -> None:
    print(f"[i] Iamhear agent '{AGENT_ID}' starting on {HOSTNAME}")
    print(f"[i] Polling every {POLL_SECONDS}s. Press Ctrl+C to stop.\n")

    # Warm all logged-in userbots up front so join jobs only run calls.play().
    await prewarm_accounts()

    # Live-detect new posts on channels our userbots are members of.
    userbot.set_view_dispatch(live_view_dispatch)
    attached = userbot.attach_view_handlers()
    if attached:
        print(f"[i] Live View handlers attached to {attached} userbot(s).")

    last_beat = 0.0
    last_view_poll = 0.0
    while True:
        # Heartbeat so the website shows the agent as online.
        now = time.time()
        if now - last_beat > 10:
            try:
                logged_in = db.query(
                    "SELECT count(*) AS c FROM telegram_accounts WHERE status = 'logged_in'"
                )
                db.heartbeat(AGENT_ID, HOSTNAME, int(logged_in[0]["c"]))
            except Exception as e:
                print(f"[!] heartbeat failed: {e}")
            last_beat = now

        # Watch channels for new posts (live handler is primary; this is fallback).
        if now - last_view_poll > VIEW_POLL_SECONDS:
            await poll_view_targets()
            last_view_poll = now

        try:
            jobs = db.claim_next_jobs(BATCH_SIZE)
        except Exception as e:
            print(f"[!] DB poll error: {e}")
            await asyncio.sleep(POLL_SECONDS)
            continue

        if not jobs:
            await asyncio.sleep(POLL_SECONDS)
            continue

        print(f"[>] Got {len(jobs)} job(s); processing concurrently.")
        # Run the whole batch at once. These are network-bound (Telegram) jobs,
        # so asyncio handles many in parallel; total time ~= the slowest job,
        # not the sum. This is what turns minutes of joins into seconds.
        await asyncio.gather(*(process_one(job) for job in jobs))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[i] Agent stopped. Bye!")
