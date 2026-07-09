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
  leave_livestream_all-> drop a whole batch of userbots out of a stream at once
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

from pathlib import Path

from dotenv import load_dotenv

# Load config from the LS_Python folder regardless of the current working
# directory (so `python -m agent.worker` and `python agent/worker.py` both work).
# `.env` is the main config and works for BOTH local PC and VPS.
#
# `.env.vps` is an OPTIONAL real override for a VPS box that wants different
# values than a shared `.env` (only load it when it actually exists — never the
# `.env.vps.example` template, which holds placeholders like
# ep-xxxxxxxxxxxx.neon.tech that would clobber a real DATABASE_URL).
_LS_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_LS_ROOT / ".env")
_vps_env = _LS_ROOT / ".env.vps"
if _vps_env.exists():
    load_dotenv(_vps_env, override=True)
# Also honor a plain `.env` in the current directory as a last resort.
load_dotenv()

from agent import db
from agent import mtproto_app
from agent import tglion
from agent import userbot

# The NEW cloud (2FA) password we set on every tg-lion account so they stay under
# OUR control. A single fixed password across all bought accounts (per config).
NEW_2FA_PASSWORD = os.environ.get("TGLION_NEW_2FA_PASSWORD", "").strip()

# A SINGLE shared Telegram api_id / api_hash that is reused to log EVERY bought
# account in over MTProto. One app credential can sign in unlimited accounts, so
# we NEVER touch my.telegram.org: the flow is simply
#   buy number -> send_code -> read login code from tg-lion -> sign in.
#
# By default we use Telegram Desktop's well-known public app credentials so the
# whole thing works out-of-the-box with zero extra setup. You can still override
# them with your own app (TGLION_API_ID / TGLION_API_HASH) in .env if you prefer.
_BUILTIN_API_ID = "2040"
_BUILTIN_API_HASH = "b18441a1ff607e10a989891a5462e627"
DEFAULT_API_ID = os.environ.get("TGLION_API_ID", "").strip() or _BUILTIN_API_ID
DEFAULT_API_HASH = os.environ.get("TGLION_API_HASH", "").strip() or _BUILTIN_API_HASH

POLL_SECONDS = float(os.environ.get("AGENT_POLL_SECONDS", "3"))
# How many queued jobs to claim and run concurrently per loop. Raise this if you
# have many userbots (e.g. 100) so they all join in one parallel batch.
BATCH_SIZE = int(os.environ.get("AGENT_BATCH_SIZE", "100"))
# Threads for off-loop DB work (asyncio.to_thread). Enough to absorb a burst of
# finishing jobs; they mostly wait on the DB connection pool so this is cheap.
DB_THREAD_WORKERS = max(8, int(os.environ.get("AGENT_DB_THREAD_WORKERS", "24")))
# How often (seconds) to check that every bot which SHOULD be live still is, and
# rejoin any that dropped. Lower = faster mass-drop recovery. 15s is a good
# balance; it's near-free when everyone is healthy.
RECONCILE_SECONDS = max(5.0, float(os.environ.get("AGENT_RECONCILE_SECONDS", "15")))
# How often to poll watched channels for new posts (live-handler fallback).
VIEW_POLL_SECONDS = float(os.environ.get("AGENT_VIEW_POLL_SECONDS", "5"))
# Safety cap: never enqueue more than this many posts at once from one detection
# (prevents a huge backfill if last_seen somehow falls far behind).
VIEW_MAX_BACKFILL = int(os.environ.get("AGENT_VIEW_MAX_BACKFILL", "30"))
# Views are trickled in over this window (front-loaded, uneven gaps) instead of
# firing all at once, so a post's view count climbs like real viewers arriving.
VIEW_SPREAD_SECONDS = float(os.environ.get("AGENT_VIEW_SPREAD_SECONDS", "45"))
# ---------------------------------------------------------------------------
# Sharding — this process handles only ITS slice of the userbots
# ---------------------------------------------------------------------------
# The supervisor (agent/supervisor.py) launches SHARD_COUNT copies of this
# worker, giving each a distinct LS_SHARD_INDEX. Each copy warms, keeps alive and
# runs jobs ONLY for accounts where (id % SHARD_COUNT == SHARD_INDEX). Spreading
# the persistent WebRTC live-stream connections across processes (each with its
# own event loop / CPU core) is what stops the mass "join then drop". Run the
# worker directly (no supervisor) and both default to 1/0 → classic single
# process, unchanged behavior.
SHARD_COUNT = max(1, int(os.environ.get("LS_WORKER_SHARDS", "1")))
SHARD_INDEX = min(max(0, int(os.environ.get("LS_SHARD_INDEX", "0"))), SHARD_COUNT - 1)
IS_SHARDED = SHARD_COUNT > 1
# Only ONE shard should do global bookkeeping (message purge, stale-job recovery,
# fan-out expansion, fallback channel polling) to avoid N× duplicate work.
IS_PRIMARY_SHARD = SHARD_INDEX == 0
# Soft ceiling: if a shard ends up warming more than this many bots, log a warning
# suggesting more shards / another VPS. It never rejects bots — just advises.
SOFT_MAX_PER_SHARD = max(1, int(os.environ.get("LS_SOFT_MAX_PER_SHARD", "70")))

_BASE_AGENT_ID = os.environ.get("AGENT_ID") or f"agent-{uuid.uuid4().hex[:8]}"
# Give each shard its own agent id + labelled hostname so the panel shows the
# health of every shard separately (and their bot counts sum to the real total).
AGENT_ID = _BASE_AGENT_ID if not IS_SHARDED else f"{_BASE_AGENT_ID}-s{SHARD_INDEX}"
_RAW_HOSTNAME = socket.gethostname()
HOSTNAME = _RAW_HOSTNAME if not IS_SHARDED else f"{_RAW_HOSTNAME} (shard {SHARD_INDEX + 1}/{SHARD_COUNT})"

# SQL fragment + params that restrict a query to accounts THIS shard owns. In
# single-process mode it is an always-true no-op so existing queries are unchanged.
_SHARD_ACCOUNT_SQL = "" if not IS_SHARDED else " AND (id %% %s) = %s"
_SHARD_ACCOUNT_PARAMS: tuple = () if not IS_SHARDED else (SHARD_COUNT, SHARD_INDEX)

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

# Bulk tg-lion buying: after each number is bought the buy job re-queues itself
# to buy the next one BUY_PACING_SECONDS later, so a 100-account order trickles
# in instead of hammering tg-lion / Telegram (which would trigger rate limits and
# waste money on numbers that then fail to log in). A single getNumber call that
# hits a transient tg-lion error (empty body / rate limit) is retried up to
# BUY_RETRY_ATTEMPTS times, BUY_RETRY_DELAY seconds apart, before that one
# purchase is given up on. All overridable from .env.
BUY_PACING_SECONDS = float(os.environ.get("AGENT_BUY_PACING_SECONDS", "8"))
BUY_RETRY_ATTEMPTS = int(os.environ.get("AGENT_BUY_RETRY_ATTEMPTS", "4"))
BUY_RETRY_DELAY = float(os.environ.get("AGENT_BUY_RETRY_DELAY", "15"))

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

async def handle_buy_tglion_batch(job: dict) -> dict:
    """
    Buy ONE tg-lion number for a bulk order, create its account row, queue its
    auto-provision job, then (if more remain) re-queue THIS job to buy the next
    number after a short pacing delay.

    This "chain" keeps the whole 1..N purchase running entirely on the agent:
      * no serverless timeout (the website only ever queues the first job),
      * money is spent one number at a time (not all up front), and
      * a gap between buys keeps tg-lion / Telegram from rate-limiting us.

    Each bought number is provisioned by its own `provision_tglion` job, so
    provisioning runs concurrently with the next purchase — bought in the exact
    country the user selected.
    """
    p = job["payload"]
    country_code = str(p.get("country_code") or "").strip()
    max_price = p.get("max_price")
    label_prefix = (p.get("label") or None)
    remaining = int(p.get("remaining") or 1)
    total = int(p.get("total") or remaining)
    index = total - remaining + 1  # 1-based position of this number in the order
    if not country_code:
        raise RuntimeError("buy_tglion_batch job is missing country_code")

    # --- buy ONE number (retry transient tg-lion errors) --------------------
    # tg-lion calls are synchronous/blocking, so run them off the event loop to
    # keep the agent heartbeating and other jobs moving.
    bought: Optional[dict] = None
    last_err: Optional[Exception] = None
    for attempt in range(1, max(1, BUY_RETRY_ATTEMPTS) + 1):
        try:
            bought = await asyncio.to_thread(tglion.get_number, country_code, max_price)
            break
        except tglion.TgLionError as e:
            last_err = e
            print(f"[buy] {country_code} {index}/{total}: attempt {attempt} failed: {e}")
            if attempt < BUY_RETRY_ATTEMPTS:
                await asyncio.sleep(BUY_RETRY_DELAY)
    if bought is None:
        raise RuntimeError(
            f"tg-lion getNumber failed after {BUY_RETRY_ATTEMPTS} tries for "
            f"{country_code}: {last_err}"
        )

    number = str(bought.get("Number") or "").strip()
    if not number:
        raise RuntimeError(f"tg-lion did not return a number: {str(bought)[:200]}")
    phone = number if number.startswith("+") else f"+{number}"

    label = None
    if label_prefix:
        label = f"{label_prefix} #{index}" if total > 1 else label_prefix

    account_id = db.create_tglion_account(phone, country_code, label)
    if account_id is not None:
        db.enqueue_job("provision_tglion", account_id, {"phone": phone, "country_code": country_code})
        print(f"[buy] {country_code} {index}/{total}: bought {phone} -> account {account_id}, provisioning queued")
    else:
        # Extremely rare: tg-lion handed back a number we already have. Don't spend
        # the chain on it — just move on to the next purchase.
        print(f"[buy] {country_code} {index}/{total}: {phone} already in system, skipped")

    # --- chain the next purchase, paced -------------------------------------
    if remaining > 1:
        db.enqueue_job_later(
            "buy_tglion_batch",
            None,
            {
                "country_code": country_code,
                "max_price": max_price,
                "label": label_prefix,
                "remaining": remaining - 1,
                "total": total,
            },
            BUY_PACING_SECONDS,
        )
        print(f"[buy] {country_code}: {remaining - 1} more to buy, next in ~{int(BUY_PACING_SECONDS)}s")

    return {
        "stage": "bought",
        "phone": phone,
        "index": index,
        "total": total,
        "price": bought.get("price"),
        "new_balance": bought.get("new_balance"),
    }


async def handle_provision_tglion(job: dict) -> dict:
    """
    Fully automatic provisioning for a number bought via tg-lion. Runs the whole
    chain the user asked for, reading the login code straight from tg-lion so no
    human ever types one and WITHOUT ever touching my.telegram.org:

      1. use a shared app credential (api_id / api_hash) - no scraping
      2. userbot login: send_code makes Telegram deliver a login code to the
         number, we read that code from tg-lion, then sign in (2FA handled via
         the tg-lion-provided password if the account had one)
      3. turn the OLD 2FA password OFF and set OUR new fixed password
      4. store the session string and mark the account 'logged_in'
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

    # IMPORTANT: tg-lion calls are SYNCHRONOUS and block (the code poll can sleep
    # for a while). Running them directly on the event loop freezes the whole
    # agent — heartbeats stop and the website reports the agent as offline
    # ("connection lost") mid-provision. So every blocking call below is pushed
    # onto a worker thread via asyncio.to_thread, keeping the loop free to
    # heartbeat, poll jobs, and drive other userbots the entire time.

    # ---- STEP 1: api_id / api_hash ------------------------------------------
    # We do NOT scrape my.telegram.org (tg-lion never delivers that web-login
    # code). Instead every account signs in with ONE shared app credential, so
    # buying a number goes straight to the userbot login below — and THAT login
    # is what makes Telegram send the code to the number, which tg-lion returns.
    api_id = acc.get("api_id") or DEFAULT_API_ID
    api_hash = acc.get("api_hash") or DEFAULT_API_HASH
    db.update_account(account_id, api_id=api_id, api_hash=api_hash, last_error=None)
    progress("Logging the userbot in with the purchased number…")

    # ---- STEP 2 + 3: userbot login, then 2FA off + new 2FA set --------------
    async def _fetch_login_code() -> tuple[str, Optional[str]]:
        # provision_userbot fires a fresh login code via pyrogram's send_code;
        # this callback then reads that code — AND the account's current cloud
        # password — off tg-lion. Both come from the same getCode response, so
        # we hand them back together: the password is what unlocks 2FA during
        # sign-in. Poll off the event loop so the agent keeps heartbeating.
        progress("Waiting for the userbot login code from tg-lion…")
        code, passwd = await asyncio.to_thread(tglion.poll_code, phone)
        if passwd:
            # Persist it too, so a later retry can reuse it if needed.
            nonlocal tg_pass
            tg_pass = passwd
            db.update_account(account_id, tglion_pass=passwd)
        progress(f"Got userbot login code {code}. Signing in…", code=code)
        return code, passwd

    result = await userbot.provision_userbot(
        int(api_id),
        api_hash,
        phone,
        _fetch_login_code,
        old_password=tg_pass,  # fallback; the password from getCode takes priority
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

    # Bail out if the task was stopped or deleted from the website while this job
    # was queued/processing. Without this a burst of queued joins would keep
    # pulling bots into a stream that the user already turned off.
    status = await db.arun(db.livestream_target_status, target_id)
    if status is None or status in ("stopped", "leaving"):
        return {"stage": "skipped", "reason": f"target {status or 'deleted'}", "target_id": target_id}

    acc = await db.arun(db.get_account, account_id)

    try:
        await userbot.join_livestream(
            account_id, int(acc["api_id"]), acc["api_hash"], acc["session_string"], chat_link
        )
        await db.arun(db.set_participant, target_id, account_id, "joined", None)
    except Exception as e:
        await db.arun(db.set_participant, target_id, account_id, "failed", str(e)[:500])
        await db.arun(db.recount_livestream, target_id)
        raise
    await db.arun(db.recount_livestream, target_id)
    return {"stage": "joined", "target_id": target_id}


async def handle_leave_livestream(job: dict) -> dict:
    account_id = job["account_id"]
    target_id = job["payload"]["target_id"]
    chat_link = job["payload"].get("chat_link", "")
    await userbot.leave_livestream(account_id, chat_link)
    await db.arun(db.set_participant, target_id, account_id, "left", None)
    await db.arun(db.recount_livestream, target_id)
    return {"stage": "left", "target_id": target_id}


async def handle_leave_livestream_all(job: dict) -> dict:
    """
    Drop a whole batch of userbots out of one live stream in a SINGLE job.

    The website enqueues just one of these (with every account_id) when a task is
    stopped or deleted, instead of one leave job per bot. All the leaves run
    concurrently, so hundreds of userbots exit within seconds. The target row may
    already be gone (delete case) - set_participant is guarded and recount is
    skipped when the target no longer exists, so this stays safe either way.
    """
    payload = job["payload"]
    target_id = payload.get("target_id")
    chat_link = payload.get("chat_link", "")
    account_ids = [int(a) for a in (payload.get("account_ids") or [])]

    left = await userbot.leave_livestream_all(account_ids, chat_link)

    if target_id is not None:
        for aid in account_ids:
            await db.arun(db.set_participant, int(target_id), aid, "left", None)
        await db.arun(db.recount_livestream, int(target_id))

    return {"stage": "left_all", "left": left, "requested": len(account_ids)}


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
    "buy_tglion_batch": handle_buy_tglion_batch,
    "provision_tglion": handle_provision_tglion,
    "create_app": handle_create_app,
    "submit_mtproto_code": handle_submit_mtproto_code,
    "send_login_code": handle_send_login_code,
    "submit_login_code": handle_submit_login_code,
    "join_livestream": handle_join_livestream,
    "leave_livestream": handle_leave_livestream,
    "leave_livestream_all": handle_leave_livestream_all,
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
        await db.arun(db.fail_job, job["id"], f"Unknown job type: {job['type']}")
        return
    try:
        result = await handler(job)
        # Run the result write OFF the event loop so a burst of finishing jobs
        # never freezes pytgcalls' sockets (the old cause of the agent stalling
        # and "socket.send() raised exception").
        await db.arun(db.finish_job, job["id"], result)
        print(f"[OK] job #{job['id']} {job['type']} -> {result.get('stage', 'done')}")
    except userbot.FloodWaitError as e:
        # Telegram rate limit that's too long to wait out inline. Don't fail the
        # job - put it back on the queue to run after the demanded wait (plus a
        # jittered buffer) so it eventually succeeds. This is what lets 500+
        # account runs complete without permanent errors.
        if job["attempts"] >= MAX_FLOOD_RETRIES:
            await db.arun(db.fail_job, job["id"], f"Gave up after {job['attempts']} rate-limit retries: {e}")
            print(f"[FAIL] job #{job['id']} {job['type']}: exhausted flood retries ({e})")
        else:
            delay = e.seconds + random.uniform(3.0, 10.0)
            await db.arun(db.reschedule_job, job["id"], delay, f"Rate limited, retrying in ~{int(delay)}s")
            print(f"[WAIT] job #{job['id']} {job['type']}: rate limited, retry in ~{int(delay)}s "
                  f"(attempt {job['attempts']}/{MAX_FLOOD_RETRIES})")
    except Exception as e:
        await db.arun(db.fail_job, job["id"], str(e))
        # Only auth/login jobs may mark the account as failed. A livestream
        # join/leave error keeps the account logged in so the website does not
        # wrongly ask the user to log the userbot in again.
        if job.get("account_id") and job["type"] in AUTH_JOB_TYPES:
            await db.arun(db.set_account_status, job["account_id"], "failed", str(e)[:500])
        print(f"[FAIL] job #{job['id']} {job['type']}: {e}")


async def prewarm_accounts() -> None:
    """Connect this shard's logged-in userbots at startup so the first joins are fast."""
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
            + _SHARD_ACCOUNT_SQL,
            _SHARD_ACCOUNT_PARAMS or None,
        )
    except Exception as e:
        print(f"[!] prewarm query failed: {e}")
        return
    if not accounts:
        return
    if IS_SHARDED and len(accounts) > SOFT_MAX_PER_SHARD:
        print(
            f"[warn] shard {SHARD_INDEX} owns {len(accounts)} bots (> soft max "
            f"{SOFT_MAX_PER_SHARD}). Consider more shards (LS_WORKER_SHARDS) or "
            f"another VPS/agent to keep live-stream connections stable."
        )
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


async def live_message_dispatch(
    account_id: int, body: str, telegram_message_id: int, sender: str, message_date
) -> None:
    """Live-handler callback: a userbot received a system message from Telegram."""
    try:
        db.store_account_message(account_id, body, telegram_message_id, sender, message_date)
        print(f"[msg] account {account_id}: stored Telegram message #{telegram_message_id}")
    except Exception as e:
        print(f"[!] failed to store message for account {account_id}: {e}")


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


async def startup_warmup() -> None:
    """
    Connect all logged-in userbots and attach live handlers IN THE BACKGROUND.

    This used to run (awaited) before the main loop started, so the agent stayed
    "offline" on the website until every userbot finished connecting - and slow
    connections/network timeouts made that take a long time. Running it as a
    background task lets the heartbeat loop start immediately (agent shows active
    right away) while userbots warm up behind the scenes.
    """
    await prewarm_accounts()

    # Live-detect new posts on channels our userbots are members of.
    attached = userbot.attach_view_handlers()
    if attached:
        print(f"[i] Live View + Reaction handlers attached to {attached} userbot(s).")

    # Capture each userbot's incoming Telegram service messages (login codes, etc.)
    # so the panel can show them per account (auto-purged after 30 minutes).
    msg_attached = userbot.attach_message_handlers()
    if msg_attached:
        print(f"[i] Message capture attached to {msg_attached} userbot(s).")


async def main() -> None:
    print(f"[i] Iamhear agent '{AGENT_ID}' starting on {HOSTNAME}")
    if IS_SHARDED:
        print(
            f"[i] Shard {SHARD_INDEX + 1}/{SHARD_COUNT}: handling accounts where "
            f"id %% {SHARD_COUNT} == {SHARD_INDEX} (soft max {SOFT_MAX_PER_SHARD})."
        )
    print(f"[i] Polling every {POLL_SECONDS}s. Press Ctrl+C to stop.\n")

    # All blocking DB work runs off the event loop via asyncio.to_thread (see
    # db.arun). Give that a dedicated, bounded thread pool so a burst of ~100
    # finishing jobs has enough threads to write results promptly without
    # spawning an unbounded number. The threads mostly wait on the DB connection
    # pool, so this stays light on the CPU.
    from concurrent.futures import ThreadPoolExecutor

    loop = asyncio.get_running_loop()
    loop.set_default_executor(
        ThreadPoolExecutor(max_workers=DB_THREAD_WORKERS, thread_name_prefix="db")
    )

    # Register dispatch callbacks up front (no network needed) so any userbot
    # that warms up in the background immediately has working live handlers.
    userbot.set_view_dispatch(live_view_dispatch)
    userbot.set_reaction_dispatch(live_reaction_dispatch)
    userbot.set_message_dispatch(live_message_dispatch)

    # Heartbeat once RIGHT NOW so the website shows the agent as online before we
    # spend any time connecting userbots.
    try:
        logged_in = db.query(
            "SELECT count(*) AS c FROM telegram_accounts WHERE status = 'logged_in'"
            + _SHARD_ACCOUNT_SQL,
            _SHARD_ACCOUNT_PARAMS or None,
        )
        db.heartbeat(AGENT_ID, HOSTNAME, int(logged_in[0]["c"]))
        print("[i] Agent registered and online. Warming userbots in background...")
    except Exception as e:
        print(f"[!] initial heartbeat failed: {e}")

    # Recover any quick jobs (esp. live-stream joins) that were stuck in
    # 'processing' because a previous run crashed/restarted mid-batch. Without
    # this, hundreds of joins claimed at crash time would never run again and
    # those bots would silently never join. Short threshold on startup so a
    # just-restarted agent recovers fast without clobbering a co-agent's fresh
    # claims. Only the primary shard does this global sweep so N shards don't all
    # race to requeue the same rows.
    if IS_PRIMARY_SHARD:
        try:
            recovered = db.requeue_stale_jobs(120)
            if recovered:
                print(f"[i] Recovered {recovered} orphaned job(s) from a previous run.")
        except Exception as e:
            print(f"[!] stale-job recovery failed: {e}")

    # Keep references to in-flight jobs so they aren't garbage-collected. Some
    # jobs (staggered views/reactions) intentionally stay alive for their whole
    # window, so we must NOT block the loop waiting for them.
    background: set[asyncio.Task] = set()

    # Warm userbots + attach handlers in the background (non-blocking).
    warmup_task = asyncio.create_task(startup_warmup())
    background.add(warmup_task)
    warmup_task.add_done_callback(background.discard)

    last_beat = 0.0
    last_view_poll = 0.0
    last_purge = 0.0
    last_reconcile = 0.0
    while True:
        # Heartbeat so the website shows the agent as online.
        now = time.time()
        if now - last_beat > 10:
            try:
                logged_in = await db.aquery(
                    "SELECT count(*) AS c FROM telegram_accounts WHERE status = 'logged_in'"
                    + _SHARD_ACCOUNT_SQL,
                    _SHARD_ACCOUNT_PARAMS or None,
                )
                await db.arun(db.heartbeat, AGENT_ID, HOSTNAME, int(logged_in[0]["c"]))
            except Exception as e:
                print(f"[!] heartbeat failed: {e}")
            # Accounts logged in AFTER startup (e.g. freshly bought) get added to
            # the pool later, so re-attach handlers here. attach_* skip clients
            # that already have one, so this is cheap and idempotent.
            try:
                userbot.attach_view_handlers()
                userbot.attach_message_handlers()
            except Exception as e:
                print(f"[!] handler re-attach failed: {e}")
            last_beat = now

        # Auto-purge Telegram messages older than 30 minutes so the panel only
        # ever shows a short, rolling window of recent notices. This is global
        # bookkeeping, so only the primary shard runs it (avoids N× duplicate work).
        if IS_PRIMARY_SHARD and now - last_purge > 60:
            try:
                removed = await db.arun(db.purge_old_account_messages)
                if removed:
                    print(f"[msg] purged {removed} message(s) older than 30 min")
            except Exception as e:
                print(f"[!] message purge failed: {e}")
            # Also sweep up any quick jobs abandoned by a crashed peer agent.
            try:
                recovered = await db.arun(db.requeue_stale_jobs, 600)
                if recovered:
                    print(f"[i] Recovered {recovered} stale job(s) back to the queue.")
            except Exception as e:
                print(f"[!] stale-job recovery failed: {e}")
            last_purge = now

        # Fan-out expansion: the primary shard turns each un-sharded view/react/
        # leave-all job into one copy per shard so the action reaches every bot
        # even though bots are split across processes. No-op in single-process mode.
        if IS_SHARDED and IS_PRIMARY_SHARD:
            try:
                expanded = await db.arun(db.expand_fanout_jobs, SHARD_COUNT)
                if expanded:
                    print(f"[shard] expanded {expanded} fan-out job(s) across {SHARD_COUNT} shards.")
            except Exception as e:
                print(f"[!] fan-out expansion failed: {e}")

        # Live-stream keep-alive on its OWN fast cadence (independent of the 60s
        # purge above). This is what makes a mass-drop like "300 joined, 270 left"
        # self-heal within seconds: any bot that dropped is rejoined through the
        # throttle. Runs often but is near-free when everyone is healthy.
        if now - last_reconcile > RECONCILE_SECONDS:
            try:
                rejoined = await userbot.reconcile_active_joins()
                if rejoined:
                    print(f"[rejoin] restored {rejoined} bot(s) that had dropped from the live stream.")
            except Exception as e:
                print(f"[!] live-stream reconcile failed: {e}")
            last_reconcile = now

        # Watch channels for new posts (the live handler on each shard's bots is
        # the primary detector; this poll is a fallback). Only the primary shard
        # runs the fallback poll so we don't hit Telegram's history API N times;
        # whichever shard detects first enqueues a single job and shard 0 expands
        # it to all shards. Live handlers still run on every shard.
        if IS_PRIMARY_SHARD and now - last_view_poll > VIEW_POLL_SECONDS:
            await poll_view_targets()
            await poll_reaction_targets()
            last_view_poll = now

        try:
            jobs = await db.arun(db.claim_next_jobs, BATCH_SIZE, SHARD_INDEX, SHARD_COUNT)
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
