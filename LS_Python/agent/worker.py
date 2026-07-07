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
  view_post           -> view a channel post from every logged-in userbot
  detect_poll         -> read the most recent poll in a channel
  cast_vote           -> make one userbot vote on a poll option
  retract_vote        -> make one userbot remove its vote from a poll
  react_post          -> react to a channel post from all userbots, time-spread
  update_profile      -> change an account's name / username / profile photo

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
import random
import socket
import time
import uuid
from typing import Any, Optional

from dotenv import load_dotenv

load_dotenv()

from agent import db
from agent import mtproto_app
from agent import tglion
from agent import userbot

# The NEW cloud (2FA) password we set on every tg-lion account so they stay under
# OUR control. A single fixed password across all bought accounts (per config).
NEW_2FA_PASSWORD = os.environ.get("TGLION_NEW_2FA_PASSWORD", "").strip()

POLL_SECONDS = float(os.environ.get("AGENT_POLL_SECONDS", "3"))
# How many queued jobs to claim and run concurrently per loop. Raise this if you
# have many userbots (e.g. 100) so they all join in one parallel batch.
BATCH_SIZE = int(os.environ.get("AGENT_BATCH_SIZE", "100"))
# How often to poll watched channels for new posts (live-handler fallback).
VIEW_POLL_SECONDS = float(os.environ.get("AGENT_VIEW_POLL_SECONDS", "5"))
# Safety cap: never enqueue more than this many posts at once from one detection
# (prevents a huge backfill if last_seen somehow falls far behind).
VIEW_MAX_BACKFILL = int(os.environ.get("AGENT_VIEW_MAX_BACKFILL", "30"))
# Views are trickled in over this window (front-loaded, uneven gaps) instead of
# firing all at once, so a post's view count climbs like real viewers arriving.
VIEW_SPREAD_SECONDS = float(os.environ.get("AGENT_VIEW_SPREAD_SECONDS", "45"))
AGENT_ID = os.environ.get("AGENT_ID") or f"agent-{uuid.uuid4().hex[:8]}"
HOSTNAME = socket.gethostname()

# Profile edits (name/username/photo) hit STRICT Telegram rate limits, so unlike
# other jobs we must not fire a whole batch at once. We run at most
# PROFILE_MAX_CONCURRENCY profile jobs at a time and pause PROFILE_JOB_DELAY_SECONDS
# (plus jitter) between them, turning a flood-triggering burst into a steady
# trickle. Raise concurrency / lower delay only if you stop seeing FloodWaits.
PROFILE_MAX_CONCURRENCY = int(os.environ.get("AGENT_PROFILE_CONCURRENCY", "1"))
PROFILE_JOB_DELAY_SECONDS = float(os.environ.get("AGENT_PROFILE_DELAY_SECONDS", "4"))

# How many times a job may be rescheduled after a long Telegram FloodWait before
# we give up and mark it failed. High enough that even heavily rate-limited bulk
# runs finish; `attempts` is incremented on every claim (see claim_next_jobs).
MAX_FLOOD_RETRIES = int(os.environ.get("AGENT_MAX_FLOOD_RETRIES", "25"))

# Created lazily inside the running event loop (see _get_profile_sem).
_profile_sem: asyncio.Semaphore | None = None


def _get_profile_sem() -> asyncio.Semaphore:
    global _profile_sem
    if _profile_sem is None:
        _profile_sem = asyncio.Semaphore(max(1, PROFILE_MAX_CONCURRENCY))
    return _profile_sem


# ---------------------------------------------------------------------------
# Job handlers. Each returns a dict that gets stored as the job result.
# ---------------------------------------------------------------------------

async def handle_provision_tglion(job: dict) -> dict:
    """
    Fully automatic provisioning for a number bought via tg-lion. Runs the whole
    chain the user asked for, reading every login code straight from tg-lion so
    no human ever types one:

      1. my.telegram.org login (code from tg-lion) -> scrape api_id / api_hash
      2. userbot login (a fresh code from tg-lion) with 2FA handled via the
         tg-lion-provided password
      3. turn the OLD 2FA password OFF and set OUR new fixed password
      4. store the session string and mark the account 'logged_in'

    The handler is resumable: if it already collected api_id/api_hash on a prior
    attempt it skips straight to the userbot login step.
    """
    if not NEW_2FA_PASSWORD:
        raise RuntimeError(
            "TGLION_NEW_2FA_PASSWORD is not set in the agent's .env — cannot set "
            "the new two-step password on provisioned accounts."
        )

    account_id = job["account_id"]
    acc = db.get_account(account_id)
    if not acc:
        raise RuntimeError(f"account {account_id} not found")
    phone = acc["phone_number"]

    db.set_account_status(account_id, "provisioning", None)

    def progress(step: str, code: str | None = None) -> None:
        """
        Write a live status line (and, when we have one, the actual login code
        read from tg-lion) onto the account row so the website can show the user
        exactly what is happening and which code was used. `code=None` leaves the
        stored code untouched; pass a code string to surface it in the UI.
        """
        fields: dict[str, Any] = {"provision_step": step}
        if code is not None:
            fields["provision_code"] = code
        try:
            db.update_account(account_id, **fields)
        except Exception as e:  # never let a progress write kill provisioning
            print(f"[prov] {phone}: progress write failed: {e}")
        print(f"[prov] {phone}: {step}" + (f" (code {code})" if code else ""))

    # The tg-lion cloud password (used to unlock 2FA at login). We learn it from
    # the first getCode call and persist it so a retry can reuse it.
    tg_pass = acc.get("tglion_pass")

    # IMPORTANT: tg-lion + my.telegram.org calls are SYNCHRONOUS and block (the
    # code poll can sleep for minutes). Running them directly on the event loop
    # freezes the whole agent — heartbeats stop and the website reports the agent
    # as offline ("connection lost") mid-provision. So every blocking call below
    # is pushed onto a worker thread via asyncio.to_thread, keeping the loop free
    # to heartbeat, poll jobs, and drive other userbots the entire time.

    # ---- STEP 1: collect api_id / api_hash from my.telegram.org -------------
    api_id = acc.get("api_id")
    api_hash = acc.get("api_hash")
    if not (api_id and api_hash):
        progress("Requesting the my.telegram.org login code…")

        def _collect_api() -> tuple[str, str, Optional[str]]:
            # Trigger the my.telegram.org login code, then read it straight off
            # tg-lion. Telegram issues a fresh code for this request, so the
            # first code tg-lion returns is the one we want.
            random_hash = mtproto_app.send_login_code(phone)
            progress("Waiting for Telegram to deliver the login code…")
            code1, pass1 = tglion.poll_code(phone)
            progress(f"Got login code {code1}. Creating the app on my.telegram.org…", code=code1)
            cookies = mtproto_app.login(phone, random_hash, code1)
            aid, ahash = mtproto_app.get_or_create_app(
                cookies, acc["app_title"], acc["short_name"]
            )
            return aid, ahash, pass1

        api_id, api_hash, pass1 = await asyncio.to_thread(_collect_api)
        if pass1:
            tg_pass = pass1
            db.update_account(account_id, tglion_pass=pass1)
        db.update_account(account_id, api_id=api_id, api_hash=api_hash, last_error=None)
        progress("API collected. Logging the userbot in…")

    # ---- STEP 2 + 3: userbot login, then 2FA off + new 2FA set --------------
    async def _fetch_login_code() -> str:
        # provision_userbot fires a fresh login code via pyrogram's send_code;
        # this callback then reads that code off tg-lion. Poll off the event
        # loop so the agent keeps heartbeating while we wait.
        progress("Waiting for the userbot login code from tg-lion…")
        code, passwd = await asyncio.to_thread(tglion.poll_code, phone)
        if passwd:
            # Refresh the stored password in case tg-lion rotated it.
            nonlocal tg_pass
            tg_pass = passwd
        progress(f"Got userbot login code {code}. Signing in…", code=code)
        return code

    result = await userbot.provision_userbot(
        int(api_id),
        api_hash,
        phone,
        _fetch_login_code,
        old_password=tg_pass,
        new_password=NEW_2FA_PASSWORD,
    )

    # ---- STEP 4: persist the session and finish -----------------------------
    db.update_account(
        account_id,
        session_string=result["session_string"],
        two_step_password=NEW_2FA_PASSWORD,
        two_factor_required=True,
        tglion_pass=None,  # no longer needed once we control the password
        login_hash=None,
        mtproto_hash=None,
        status="logged_in",
        last_error=None,
        provision_step=None,  # clear the live progress once we're done
        provision_code=None,
    )
    return {
        "stage": "logged_in",
        "had_2fa": result.get("had_2fa"),
        "two_step_set": result.get("two_step_set"),
    }


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

    count = await userbot.view_post_all(chat_id, message_id, VIEW_SPREAD_SECONDS)
    if target_id:
        db.bump_view_sent(int(target_id), count)
    return {"stage": "viewed", "views": count, "message_id": message_id}


async def handle_detect_poll(job: dict) -> dict:
    """Read the channel's most recent poll and fill in the vote_target."""
    target_id = job["payload"]["target_id"]
    link = job["payload"]["poll_link"]
    try:
        info = await userbot.detect_recent_poll(link)
    except Exception as e:
        db.set_vote_target_error(target_id, str(e))
        raise
    db.set_vote_target_meta(
        target_id,
        chat_id=info["chat_id"],
        message_id=info["message_id"],
        poll_id=info["poll_id"],
        question=info["question"],
        options=info["options"],
        multiple_choice=info["multiple_choice"],
    )
    return {"stage": "poll_detected", "options": len(info["options"])}


async def handle_cast_vote(job: dict) -> dict:
    """Make one userbot vote on a poll option."""
    account_id = job["account_id"]
    p = job["payload"]
    target_id = p["target_id"]
    acc = db.get_account(account_id)
    try:
        await userbot.vote_on_poll(
            account_id,
            int(acc["api_id"]),
            acc["api_hash"],
            acc["session_string"],
            p.get("poll_link", ""),
            int(p["chat_id"]) if p.get("chat_id") is not None else None,
            int(p["message_id"]),
            int(p["option_index"]),
        )
        db.set_vote_cast(target_id, account_id, "voted", None)
    except Exception as e:
        db.set_vote_cast(target_id, account_id, "failed", str(e)[:500])
        raise
    return {"stage": "voted", "target_id": target_id}


async def handle_retract_vote(job: dict) -> dict:
    """Make one userbot remove its vote; on success the cast row is deleted."""
    account_id = job["account_id"]
    p = job["payload"]
    cast_id = p["cast_id"]
    acc = db.get_account(account_id)
    try:
        await userbot.retract_poll_vote(
            account_id,
            int(acc["api_id"]),
            acc["api_hash"],
            acc["session_string"],
            p.get("poll_link", ""),
            int(p["chat_id"]) if p.get("chat_id") is not None else None,
            int(p["message_id"]),
        )
        db.delete_vote_cast(cast_id)
    except Exception as e:
        # Keep the vote counted (revert to 'voted') and surface the error.
        db.set_vote_cast_by_id(cast_id, "voted", str(e)[:500])
        raise
    return {"stage": "retracted", "cast_id": cast_id}


# Reaction pacing windows (seconds) for the non-custom presets. Reactions are
# front-loaded inside the window (a quick burst after the post, then a tail), so
# the FIRST reactions always land within a few seconds - these are the full
# spread, not the delay before the first one. Override via env if you want.
REACTION_WINDOWS = {
    "fast": float(os.environ.get("AGENT_REACT_FAST_SECONDS", "30")),
    "medium": float(os.environ.get("AGENT_REACT_MEDIUM_SECONDS", "120")),
    "slow": float(os.environ.get("AGENT_REACT_SLOW_SECONDS", "360")),
}


async def handle_react_post(job: dict) -> dict:
    """
    React to a single channel post from EVERY warm userbot, staggered over a
    time window. One of these jobs is queued per new post on a watched channel.
    """
    p = job["payload"]
    chat_id = int(p["chat_id"])
    message_id = int(p["message_id"])
    target_id = p.get("target_id")
    emojis = p.get("emojis") or []
    mode = p.get("mode", "medium")

    if mode == "custom":
        # Exact window the user asked for (minimum 1 minute).
        window = max(1, int(p.get("custom_minutes", 1))) * 60.0
    else:
        window = REACTION_WINDOWS.get(mode, REACTION_WINDOWS["medium"])

    count = await userbot.react_post_scheduled(chat_id, message_id, emojis, window)
    if target_id:
        db.bump_reaction_sent(int(target_id), count)
    return {"stage": "reacted", "reactions": count, "message_id": message_id}


async def handle_update_profile(job: dict) -> dict:
    """
    Throttled entry point for profile jobs. Telegram rate-limits name/username/
    photo changes hard, so we serialize them through a semaphore and pause between
    each one (see PROFILE_* config) instead of firing the whole batch at once,
    which is what triggers the "Rate limited by Telegram" FloodWaits.
    """
    async with _get_profile_sem():
        try:
            return await _run_update_profile(job)
        finally:
            # Pause before releasing so the NEXT profile job starts spaced out.
            await asyncio.sleep(PROFILE_JOB_DELAY_SECONDS + random.uniform(0.0, 1.5))


async def _run_update_profile(job: dict) -> dict:
    """
    Change one account's name / username / profile photo. The website queues one
    of these per selected account. When several photos are uploaded the website
    picks a RANDOM one per account, so each job carries its own photo_asset_id
    (a single upload means every job shares the same id). We just fetch whatever
    asset id this job references. We write the result back to the matching
    profile_updates row so the UI shows per-account progress, and we mirror the
    new name onto telegram_accounts.label for display.
    """
    account_id = job["account_id"]
    p = job["payload"]
    update_id = p.get("profile_update_id")
    acc = db.get_account(account_id)
    if not acc:
        raise RuntimeError(f"account {account_id} not found")

    photo_bytes = None
    if p.get("photo_asset_id"):
        photo_bytes = db.get_profile_photo(int(p["photo_asset_id"]))

    try:
        result = await userbot.update_profile(
            account_id,
            int(acc["api_id"]),
            acc["api_hash"],
            acc["session_string"],
            first_name=p.get("first_name"),
            last_name=p.get("last_name"),
            username=p.get("username"),
            username_base=p.get("username_base"),
            auto_username=bool(p.get("auto_username")),
            photo_bytes=photo_bytes,
        )
        # Persist the username that actually stuck (auto-generated ones differ
        # from the placeholder base we stored when queuing).
        final_username = result.get("username")
        if update_id:
            if final_username:
                db.set_profile_update(int(update_id), "done", None, username=final_username)
            else:
                db.set_profile_update(int(update_id), "done", None)
        return {"stage": "profile_updated", "changed": result.get("changed", []), "username": final_username}
    except Exception as e:
        if update_id:
            db.set_profile_update(int(update_id), "failed", str(e))
        raise


HANDLERS = {
    "provision_tglion": handle_provision_tglion,
    "create_app": handle_create_app,
    "submit_mtproto_code": handle_submit_mtproto_code,
    "send_login_code": handle_send_login_code,
    "submit_login_code": handle_submit_login_code,
    "join_livestream": handle_join_livestream,
    "leave_livestream": handle_leave_livestream,
    "view_post": handle_view_post,
    "detect_poll": handle_detect_poll,
    "cast_vote": handle_cast_vote,
    "retract_vote": handle_retract_vote,
    "react_post": handle_react_post,
    "update_profile": handle_update_profile,
}

# Jobs that are part of the login / auth flow. ONLY these may flip an account
# into the 'failed' state (which makes the website ask for re-login). A livestream
# join/leave failure must NEVER log the userbot out - the account is still valid.
AUTH_JOB_TYPES = {
    "provision_tglion",
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
    except userbot.FloodWaitError as e:
        # Telegram rate limit that's too long to wait out inline. Don't fail the
        # job - put it back on the queue to run after the demanded wait (plus a
        # jittered buffer) so it eventually succeeds. This is what lets 500+
        # account runs complete without permanent errors.
        if job["attempts"] >= MAX_FLOOD_RETRIES:
            db.fail_job(job["id"], f"Gave up after {job['attempts']} rate-limit retries: {e}")
            print(f"[FAIL] job #{job['id']} {job['type']}: exhausted flood retries ({e})")
        else:
            delay = e.seconds + random.uniform(3.0, 10.0)
            db.reschedule_job(job["id"], delay, f"Rate limited, retrying in ~{int(delay)}s")
            print(f"[WAIT] job #{job['id']} {job['type']}: rate limited, retry in ~{int(delay)}s "
                  f"(attempt {job['attempts']}/{MAX_FLOOD_RETRIES})")
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


async def dispatch_reactions_for_target(target: dict, chat_id: int, latest_id: int) -> None:
    """
    Atomically claim the new post range for a reaction target and queue one
    react_post job per new post. Mirrors the Live View dispatch so the live
    handler and polling fallback never double-react.
    """
    old = db.claim_reaction_advance(target["id"], latest_id)
    if old is None:
        return  # already handled by the other detection path
    start = max(int(old) + 1, latest_id - VIEW_MAX_BACKFILL + 1)
    post_ids = list(range(start, latest_id + 1))
    if not post_ids:
        return

    emojis = target.get("emojis") or []
    if isinstance(emojis, str):  # safety: in case the driver returns raw JSON text
        import json as _json
        emojis = _json.loads(emojis)
    mode = target.get("mode", "medium")
    custom_minutes = int(target.get("custom_minutes", 5) or 5)

    for mid in post_ids:
        db.enqueue_reaction_job(chat_id, mid, target["id"], emojis, mode, custom_minutes)
    db.bump_reaction_posts(target["id"], len(post_ids))
    print(f"[react] target {target['id']}: queued {len(post_ids)} new post(s) up to #{latest_id}")


async def live_reaction_dispatch(chat_id: int, message_id: int) -> None:
    """Live-handler callback: a watched (reaction) channel just got a new post."""
    target = db.get_reaction_target_by_chat(chat_id)
    if not target or target["status"] != "active" or target["last_seen_message_id"] == 0:
        return
    await dispatch_reactions_for_target(target, chat_id, message_id)


async def poll_reaction_targets() -> None:
    """
    Fallback detector for reaction channels: resolve chat_id/title on first sight,
    set the future-only baseline, then queue reactions for any new posts.
    """
    try:
        targets = db.get_active_reaction_targets()
    except Exception as e:
        print(f"[!] reaction targets query failed: {e}")
        return

    for t in targets:
        try:
            ref = t["chat_id"] if t["chat_id"] is not None else t["channel_link"]
            chat_id, title, latest = await userbot.resolve_channel_latest(ref)

            if t["chat_id"] is None or not t["title"]:
                db.set_reaction_target_meta(t["id"], chat_id, title)

            if t["last_seen_message_id"] == 0:
                db.init_reaction_baseline(t["id"], latest)
                continue

            t = {**t, "chat_id": chat_id}
            await dispatch_reactions_for_target(t, chat_id, latest)
        except userbot.UserbotError:
            return  # no warm userbots yet
        except Exception as e:
            db.set_reaction_target_error(t["id"], str(e)[:500])
            print(f"[!] reaction poll failed for target {t['id']}: {e}")


async def main() -> None:
    print(f"[i] Iamhear agent '{AGENT_ID}' starting on {HOSTNAME}")
    print(f"[i] Polling every {POLL_SECONDS}s. Press Ctrl+C to stop.\n")

    # Warm all logged-in userbots up front so join jobs only run calls.play().
    await prewarm_accounts()

    # Live-detect new posts on channels our userbots are members of.
    userbot.set_view_dispatch(live_view_dispatch)
    userbot.set_reaction_dispatch(live_reaction_dispatch)
    attached = userbot.attach_view_handlers()
    if attached:
        print(f"[i] Live View + Reaction handlers attached to {attached} userbot(s).")

    # Keep references to in-flight jobs so they aren't garbage-collected. Some
    # jobs (staggered views/reactions) intentionally stay alive for their whole
    # window, so we must NOT block the loop waiting for them.
    background: set[asyncio.Task] = set()

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
            await poll_reaction_targets()
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

        print(f"[>] Got {len(jobs)} job(s); dispatching concurrently.")
        # Fire each job as its own background task so the loop keeps polling and
        # heartbeating. This lets long, time-spread reaction jobs run in parallel
        # with views (and everything else) - so on a channel with BOTH enabled,
        # views and reactions trickle in together instead of one burst then the
        # other. Jobs are already claimed in the DB, so they won't be re-run.
        for job in jobs:
            task = asyncio.create_task(process_one(job))
            background.add(task)
            task.add_done_callback(background.discard)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[i] Agent stopped. Bye!")
