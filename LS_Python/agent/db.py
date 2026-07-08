"""
Database helper for the Iamhear userbot agent.

The agent talks to the SAME Neon Postgres database the website uses. There is no
HTTP API between them - the website writes "jobs" into the `jobs` table, and this
agent polls that table, executes each job (my.telegram.org app creation, userbot
login, live stream join, ...) and writes the result back.

This file uses psycopg (v3) with a simple connection-per-call model. That keeps
the agent dead-simple and robust whether you run it on a local PC or a VPS.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

# DATABASE_URL is the Neon connection string. Same value as the website's env.
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Pool size. Kept modest because Neon (via the -pooler endpoint) is happiest with
# a bounded number of server connections; the agent reuses these warm connections
# for ALL its queries instead of doing a fresh TLS handshake every call.
_POOL_MIN = max(1, int(os.environ.get("AGENT_DB_POOL_MIN", "2")))
_POOL_MAX = max(_POOL_MIN, int(os.environ.get("AGENT_DB_POOL_MAX", "10")))

# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------
# WHY THIS EXISTS: previously every query opened a brand-new psycopg connection,
# which means a full TCP + TLS handshake to Neon (~100-300 ms) EVERY call. Those
# calls run on the agent's single asyncio event loop, so when ~100 livestream
# joins finished at once and each wrote its result, the loop froze for many
# seconds doing back-to-back handshakes. While the loop is frozen, pytgcalls /
# pyrogram can't service their sockets -> "socket.send() raised exception", the
# agent appears stuck, and live-stream calls get dropped. A warm pooled
# connection turns each call into ~1-5 ms, so the loop stays responsive.

_pool = None            # psycopg_pool.ConnectionPool when available
_pool_lock = threading.Lock()
_pool_disabled = False  # set True if psycopg_pool isn't installed (fallback mode)


def _get_pool():
    """Lazily build the shared connection pool (thread-safe). Returns None if the
    psycopg_pool package isn't installed, in which case we fall back to a fresh
    connection per call."""
    global _pool, _pool_disabled
    if _pool is not None or _pool_disabled:
        return _pool
    with _pool_lock:
        if _pool is not None or _pool_disabled:
            return _pool
        try:
            from psycopg_pool import ConnectionPool

            _pool = ConnectionPool(
                conninfo=DATABASE_URL,
                min_size=_POOL_MIN,
                max_size=_POOL_MAX,
                max_idle=60.0,
                # Recycle connections periodically so a Neon compute suspend /
                # network blip can never hand us a dead socket.
                max_lifetime=600.0,
                timeout=30.0,
                kwargs={"row_factory": dict_row, "autocommit": True},
                open=True,
            )
        except Exception as e:
            # psycopg_pool missing or failed to init -> fall back gracefully.
            print(f"[db] connection pool unavailable ({e}); using per-call connections.")
            _pool_disabled = True
            _pool = None
        return _pool


def _connect() -> psycopg.Connection:
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and paste your "
            "Neon connection string (the same one the website uses)."
        )
    # autocommit=True: each statement commits immediately. Good enough for a
    # single-worker agent and avoids dangling transactions on long jobs.
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True)


def query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and paste your "
            "Neon connection string (the same one the website uses)."
        )
    pool = _get_pool()
    if pool is not None:
        # Reuse a warm pooled connection (fast, no TLS handshake per call).
        with pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                if cur.description is None:
                    return []
                return cur.fetchall()
    # Fallback: fresh connection per call (only when psycopg_pool isn't installed).
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return []
            return cur.fetchall()


def query_one(sql: str, params: tuple = ()) -> Optional[dict[str, Any]]:
    rows = query(sql, params)
    return rows[0] if rows else None


async def aquery(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    """Async wrapper: run a query in a worker thread so the caller's event loop
    (which also drives pytgcalls) is never blocked on database I/O."""
    return await asyncio.to_thread(query, sql, params)


async def arun(fn, *args, **kwargs):
    """Run any blocking db.* helper off the event loop. Use this from async code
    (worker job handlers, the main loop) so DB writes never freeze pytgcalls."""
    return await asyncio.to_thread(fn, *args, **kwargs)


# ---------------------------------------------------------------------------
# Job queue helpers
# ---------------------------------------------------------------------------

def claim_next_job() -> Optional[dict[str, Any]]:
    """
    Atomically grab the oldest queued job and mark it 'processing'.

    FOR UPDATE SKIP LOCKED makes this safe even if you run multiple agents:
    two agents will never grab the same job.
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE jobs
                SET status = 'processing',
                    attempts = attempts + 1,
                    claimed_at = now(),
                    updated_at = now()
                WHERE id = (
                    SELECT id FROM jobs
                    WHERE status = 'queued'
                      AND run_after <= now()
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING *
                """
            )
            return cur.fetchone()


def claim_next_jobs(limit: int = 50) -> list[dict[str, Any]]:
    """
    Atomically grab up to `limit` of the oldest queued jobs and mark them
    'processing' in a single round-trip. This lets the worker run many jobs
    (e.g. 100 livestream joins) concurrently instead of one-at-a-time.

    FOR UPDATE SKIP LOCKED keeps this safe across multiple agents.
    """
    if limit < 1:
        limit = 1
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE jobs
                SET status = 'processing',
                    attempts = attempts + 1,
                    claimed_at = now(),
                    updated_at = now()
                WHERE id IN (
                    SELECT id FROM jobs
                    WHERE status = 'queued'
                      AND run_after <= now()
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT %s
                )
                RETURNING *
                """,
                (limit,),
            )
            return cur.fetchall()


def enqueue_job(job_type: str, account_id: int | None, payload: dict[str, Any] | None = None) -> None:
    """Queue a new job to run as soon as the worker next polls."""
    query(
        "INSERT INTO jobs (type, account_id, payload, status) VALUES (%s, %s, %s::jsonb, 'queued')",
        (job_type, account_id, json.dumps(payload or {})),
    )


def enqueue_job_later(
    job_type: str,
    account_id: int | None,
    payload: dict[str, Any] | None,
    delay_seconds: float,
) -> None:
    """
    Queue a new job to run only after `delay_seconds`. Used to PACE bulk buys:
    the buy handler re-queues itself with a small delay so we don't hammer
    tg-lion / Telegram when ordering many numbers in one go.
    """
    query(
        "INSERT INTO jobs (type, account_id, payload, status, run_after) "
        "VALUES (%s, %s, %s::jsonb, 'queued', now() + (%s || ' seconds')::interval)",
        (job_type, account_id, json.dumps(payload or {}), max(0.0, float(delay_seconds))),
    )


def finish_job(job_id: int, result: dict[str, Any] | None = None) -> None:
    query(
        "UPDATE jobs SET status = 'done', result = %s::jsonb, error = NULL, updated_at = now() WHERE id = %s",
        (json.dumps(result or {}), job_id),
    )


def fail_job(job_id: int, error: str) -> None:
    query(
        "UPDATE jobs SET status = 'failed', error = %s, updated_at = now() WHERE id = %s",
        (error[:2000], job_id),
    )


def reschedule_job(job_id: int, delay_seconds: float, note: str | None = None) -> None:
    """
    Put a claimed job back on the queue to run after `delay_seconds`. Used for
    Telegram FloodWait rate limits: instead of permanently failing the job, we
    retry it later so every account eventually succeeds. `error` holds the last
    reason for visibility but the job stays 'queued', not 'failed'.
    """
    delay = max(0.0, float(delay_seconds))
    query(
        """
        UPDATE jobs
        SET status = 'queued',
            run_after = now() + (%s || ' seconds')::interval,
            error = %s,
            updated_at = now()
        WHERE id = %s
        """,
        (delay, (note or "")[:2000], job_id),
    )


# Job types that must always be QUICK. If one of these has been stuck in
# 'processing' past the stale threshold it can only mean the agent that claimed
# it died/restarted (nothing runs this long normally), so it is safe to put back
# on the queue. We deliberately EXCLUDE view_post / react_post because those are
# intentionally long-lived (they trickle actions over minutes) and must not be
# requeued mid-run.
_STALE_REQUEUE_TYPES = (
    "join_livestream",
    "leave_livestream",
    "leave_livestream_all",
    "cast_vote",
    "retract_vote",
    "detect_poll",
)


def requeue_stale_jobs(older_than_seconds: float = 600.0) -> int:
    """
    Recover orphaned jobs: any quick job stuck in 'processing' longer than
    `older_than_seconds` is flipped back to 'queued' so it runs again. This is
    what makes a big live-stream run survive an agent restart — without it, the
    hundreds of joins claimed at crash time would sit 'processing' forever and
    those bots would silently never join. Returns how many were recovered.

    Uses a time threshold (not a blanket reset) so it stays safe when several
    agents share the queue: a job another agent is actively working on won't be
    yanked away unless it has clearly been abandoned.
    """
    secs = max(30.0, float(older_than_seconds))
    rows = query(
        """
        UPDATE jobs
        SET status = 'queued',
            run_after = now(),
            error = 'Recovered after agent restart (was stuck processing)',
            updated_at = now()
        WHERE status = 'processing'
          AND type = ANY(%s)
          AND claimed_at < now() - (%s || ' seconds')::interval
        RETURNING id
        """,
        (list(_STALE_REQUEUE_TYPES), secs),
    )
    return len(rows)


# ---------------------------------------------------------------------------
# Account helpers
# ---------------------------------------------------------------------------

def get_account(account_id: int) -> Optional[dict[str, Any]]:
    return query_one("SELECT * FROM telegram_accounts WHERE id = %s", (account_id,))


def create_tglion_account(phone: str, country_code: str, label: str | None = None) -> Optional[int]:
    """
    Insert a freshly bought tg-lion account row (status 'purchased'). Returns the
    new account id, or None if a row for this phone already existed (so the buy
    handler can skip re-provisioning it).
    """
    row = query_one(
        """
        INSERT INTO telegram_accounts (label, phone_number, status, source, country_code)
        VALUES (%s, %s, 'purchased', 'tglion', %s)
        ON CONFLICT (phone_number) DO NOTHING
        RETURNING id
        """,
        (label, phone, country_code),
    )
    return row["id"] if row else None


# ---------------------------------------------------------------------------
# Incoming Telegram messages (ephemeral, 30-minute window)
# ---------------------------------------------------------------------------

def store_account_message(
    account_id: int,
    body: str,
    telegram_message_id: int | None,
    sender: str = "Telegram",
    message_date: Any = None,
) -> None:
    """
    Save one incoming Telegram message for an account. ON CONFLICT DO NOTHING on
    (account_id, telegram_message_id) makes it safe if the same update is
    delivered more than once — a given message is stored only the first time.
    """
    query(
        """
        INSERT INTO account_messages (account_id, sender, telegram_message_id, body, message_date)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (account_id, telegram_message_id) DO NOTHING
        """,
        (account_id, sender, telegram_message_id, body, message_date),
    )


def purge_old_account_messages() -> int:
    """
    Delete every stored message older than 30 minutes. Returns how many rows were
    removed. Called periodically by the worker so the table only ever holds a
    short, rolling window of recent notices.
    """
    rows = query(
        "DELETE FROM account_messages WHERE created_at < now() - interval '30 minutes' RETURNING id"
    )
    return len(rows)


def update_account(account_id: int, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = %s" for k in fields)
    params = tuple(fields.values()) + (account_id,)
    query(f"UPDATE telegram_accounts SET {cols}, updated_at = now() WHERE id = %s", params)


def set_account_status(account_id: int, status: str, error: str | None = None) -> None:
    update_account(account_id, status=status, last_error=error)


# ---------------------------------------------------------------------------
# Livestream helpers
# ---------------------------------------------------------------------------

def set_participant(target_id: int, account_id: int, status: str, error: str | None = None) -> None:
    # Guard against a deleted target: if the live stream task was removed while a
    # leave job was still queued, the bot has already physically left the call and
    # the participant bookkeeping is no longer needed. The WHERE EXISTS keeps the
    # INSERT from violating the target_id foreign key.
    query(
        """
        INSERT INTO livestream_participants (target_id, account_id, status, last_error)
        SELECT %s, %s, %s, %s
        WHERE EXISTS (SELECT 1 FROM livestream_targets WHERE id = %s)
        ON CONFLICT (target_id, account_id)
        DO UPDATE SET status = EXCLUDED.status, last_error = EXCLUDED.last_error, updated_at = now()
        """,
        (target_id, account_id, status, error, target_id),
    )


def recount_livestream(target_id: int) -> None:
    """Recompute joined_count and overall status for a livestream target."""
    query(
        """
        UPDATE livestream_targets t SET
            joined_count = (
                SELECT count(*) FROM livestream_participants
                WHERE target_id = t.id AND status = 'joined'
            ),
            status = CASE
                WHEN (SELECT count(*) FROM livestream_participants
                      WHERE target_id = t.id AND status = 'joined') > 0 THEN 'active'
                WHEN (SELECT count(*) FROM livestream_participants
                      WHERE target_id = t.id AND status = 'pending') > 0 THEN 'joining'
                ELSE 'stopped'
            END,
            updated_at = now()
        WHERE t.id = %s
        """,
        (target_id,),
    )


def livestream_target_status(target_id: int) -> str | None:
    """
    Return the current status of a livestream target, or None if the row no
    longer exists. Used by the join handler to bail out when a task was stopped
    or deleted from the website while its join job was still queued/processing,
    so bots are never pulled into a stream that is being torn down.
    """
    row = query_one("SELECT status FROM livestream_targets WHERE id = %s", (target_id,))
    return row["status"] if row else None


# ---------------------------------------------------------------------------
# Live View helpers (auto-view future channel posts)
# ---------------------------------------------------------------------------

def get_active_view_targets() -> list[dict[str, Any]]:
    """All channels currently being watched for auto-viewing."""
    return query("SELECT * FROM view_targets WHERE status = 'active' ORDER BY id")


def get_view_target_by_chat(chat_id: int) -> Optional[dict[str, Any]]:
    return query_one("SELECT * FROM view_targets WHERE chat_id = %s", (chat_id,))


def set_view_target_meta(target_id: int, chat_id: int, title: str | None) -> None:
    """Store the resolved Telegram chat_id + title once we look the channel up."""
    query(
        "UPDATE view_targets SET chat_id = %s, title = COALESCE(%s, title), "
        "last_checked_at = now(), last_error = NULL, updated_at = now() WHERE id = %s",
        (chat_id, title, target_id),
    )


def init_view_baseline(target_id: int, latest_message_id: int) -> None:
    """
    Set the starting point for a freshly added channel WITHOUT viewing anything.
    Only posts newer than this baseline get auto-viewed (clean future-only cutoff).
    """
    query(
        "UPDATE view_targets SET last_seen_message_id = %s, last_checked_at = now(), "
        "updated_at = now() WHERE id = %s AND last_seen_message_id = 0",
        (latest_message_id, target_id),
    )


def claim_view_advance(target_id: int, new_message_id: int) -> Optional[int]:
    """
    Atomically advance last_seen_message_id to new_message_id IF it is greater.
    Returns the previous value when we advanced (so the caller knows which post
    ids are new), or None if another path already handled this post. This makes
    the live-handler and the polling fallback safe to run together (no dupes).
    """
    row = query_one(
        """
        WITH cur AS (
            SELECT last_seen_message_id AS old FROM view_targets WHERE id = %s FOR UPDATE
        )
        UPDATE view_targets v
        SET last_seen_message_id = %s, last_checked_at = now(), updated_at = now()
        FROM cur
        WHERE v.id = %s AND cur.old < %s
        RETURNING cur.old AS old
        """,
        (target_id, new_message_id, target_id, new_message_id),
    )
    return row["old"] if row else None


def bump_view_posts(target_id: int, posts: int) -> None:
    query(
        "UPDATE view_targets SET posts_viewed = posts_viewed + %s, last_post_at = now(), "
        "updated_at = now() WHERE id = %s",
        (posts, target_id),
    )


def bump_view_sent(target_id: int, views: int) -> None:
    query(
        "UPDATE view_targets SET views_sent = views_sent + %s, updated_at = now() WHERE id = %s",
        (views, target_id),
    )


def set_view_target_error(target_id: int, error: str | None) -> None:
    query(
        "UPDATE view_targets SET last_error = %s, last_checked_at = now(), updated_at = now() WHERE id = %s",
        (error, target_id),
    )


def enqueue_view_job(chat_id: int, message_id: int, target_id: int) -> None:
    """Queue a single view_post job (fans out to all userbots inside the agent)."""
    query(
        "INSERT INTO jobs (type, account_id, payload, status) "
        "VALUES ('view_post', NULL, %s::jsonb, 'queued')",
        (json.dumps({"chat_id": chat_id, "message_id": message_id, "target_id": target_id}),),
    )


# ---------------------------------------------------------------------------
# Vote helpers (detect a poll, then vote / un-vote on it)
# ---------------------------------------------------------------------------

def set_vote_target_meta(
    target_id: int,
    *,
    chat_id: int,
    message_id: int,
    poll_id: str,
    question: str | None,
    options: list[dict[str, Any]],
    multiple_choice: bool,
) -> None:
    """Store the detected poll details and flip the target to 'ready'."""
    query(
        """
        UPDATE vote_targets
        SET chat_id = %s, message_id = %s, poll_id = %s, question = %s,
            options = %s::jsonb, multiple_choice = %s,
            status = 'ready', last_error = NULL, updated_at = now()
        WHERE id = %s
        """,
        (chat_id, message_id, poll_id, question, json.dumps(options), multiple_choice, target_id),
    )


def set_vote_target_error(target_id: int, error: str | None) -> None:
    query(
        "UPDATE vote_targets SET status = 'failed', last_error = %s, updated_at = now() WHERE id = %s",
        ((error or "")[:500], target_id),
    )


def set_vote_cast(target_id: int, account_id: int, status: str, error: str | None = None) -> None:
    """Update a single account's cast row on a poll (identified by target+account)."""
    query(
        """
        UPDATE vote_casts SET status = %s, last_error = %s, updated_at = now()
        WHERE target_id = %s AND account_id = %s
        """,
        (status, error, target_id, account_id),
    )


def set_vote_cast_by_id(cast_id: int, status: str, error: str | None = None) -> None:
    query(
        "UPDATE vote_casts SET status = %s, last_error = %s, updated_at = now() WHERE id = %s",
        (status, error, cast_id),
    )


def delete_vote_cast(cast_id: int) -> None:
    """Remove a cast row entirely - frees that account to vote again on this poll."""
    query("DELETE FROM vote_casts WHERE id = %s", (cast_id,))


# ---------------------------------------------------------------------------
# Reaction helpers (auto-react to future channel posts)
# ---------------------------------------------------------------------------

def get_active_reaction_targets() -> list[dict[str, Any]]:
    """All channels currently being watched for auto-reacting."""
    return query("SELECT * FROM reaction_targets WHERE status = 'active' ORDER BY id")


def get_reaction_target_by_chat(chat_id: int) -> Optional[dict[str, Any]]:
    return query_one("SELECT * FROM reaction_targets WHERE chat_id = %s", (chat_id,))


def set_reaction_target_meta(target_id: int, chat_id: int, title: str | None) -> None:
    """Store the resolved Telegram chat_id + title once we look the channel up."""
    query(
        "UPDATE reaction_targets SET chat_id = %s, title = COALESCE(%s, title), "
        "last_checked_at = now(), last_error = NULL, updated_at = now() WHERE id = %s",
        (chat_id, title, target_id),
    )


def init_reaction_baseline(target_id: int, latest_message_id: int) -> None:
    """Set the future-only cutoff for a freshly added channel (reacts to nothing old)."""
    query(
        "UPDATE reaction_targets SET last_seen_message_id = %s, last_checked_at = now(), "
        "updated_at = now() WHERE id = %s AND last_seen_message_id = 0",
        (latest_message_id, target_id),
    )


def claim_reaction_advance(target_id: int, new_message_id: int) -> Optional[int]:
    """
    Atomically advance last_seen_message_id IF new_message_id is greater. Returns
    the previous value when advanced (so the caller knows which posts are new),
    or None if another path already handled this post. Keeps the live handler and
    the polling fallback from double-reacting.
    """
    row = query_one(
        """
        WITH cur AS (
            SELECT last_seen_message_id AS old FROM reaction_targets WHERE id = %s FOR UPDATE
        )
        UPDATE reaction_targets v
        SET last_seen_message_id = %s, last_checked_at = now(), updated_at = now()
        FROM cur
        WHERE v.id = %s AND cur.old < %s
        RETURNING cur.old AS old
        """,
        (target_id, new_message_id, target_id, new_message_id),
    )
    return row["old"] if row else None


def bump_reaction_posts(target_id: int, posts: int) -> None:
    query(
        "UPDATE reaction_targets SET posts_reacted = posts_reacted + %s, last_post_at = now(), "
        "updated_at = now() WHERE id = %s",
        (posts, target_id),
    )


def bump_reaction_sent(target_id: int, reactions: int) -> None:
    query(
        "UPDATE reaction_targets SET reactions_sent = reactions_sent + %s, updated_at = now() WHERE id = %s",
        (reactions, target_id),
    )


def set_reaction_target_error(target_id: int, error: str | None) -> None:
    query(
        "UPDATE reaction_targets SET last_error = %s, last_checked_at = now(), updated_at = now() WHERE id = %s",
        (error, target_id),
    )


def enqueue_reaction_job(
    chat_id: int,
    message_id: int,
    target_id: int,
    emojis: list[str],
    mode: str,
    custom_minutes: int,
) -> None:
    """Queue a single react_post job (fans out to all userbots inside the agent)."""
    query(
        "INSERT INTO jobs (type, account_id, payload, status) "
        "VALUES ('react_post', NULL, %s::jsonb, 'queued')",
        (
            json.dumps(
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "target_id": target_id,
                    "emojis": emojis,
                    "mode": mode,
                    "custom_minutes": custom_minutes,
                }
            ),
        ),
    )


# ---------------------------------------------------------------------------
# Profile edit helpers (change an account's name / username / photo)
# ---------------------------------------------------------------------------

def get_profile_photo(asset_id: int) -> Optional[bytes]:
    """Fetch a stored profile photo (base64 in profile_assets) as raw bytes."""
    import base64

    row = query_one("SELECT data FROM profile_assets WHERE id = %s", (asset_id,))
    if not row or not row.get("data"):
        return None
    return base64.b64decode(row["data"])


def set_profile_update(
    update_id: int,
    status: str,
    error: str | None = None,
    username: str | None = None,
) -> None:
    """
    Record the outcome of a single profile edit request. When `username` is given
    (e.g. an auto-generated handle that was finalized), store it so the UI shows
    the actual username applied rather than the placeholder base.
    """
    if username:
        query(
            "UPDATE profile_updates SET status = %s, last_error = %s, username = %s, updated_at = now() WHERE id = %s",
            (status, error[:500] if error else None, username, update_id),
        )
    else:
        query(
            "UPDATE profile_updates SET status = %s, last_error = %s, updated_at = now() WHERE id = %s",
            (status, error[:500] if error else None, update_id),
        )


# ---------------------------------------------------------------------------
# Agent heartbeat
# ---------------------------------------------------------------------------

def heartbeat(agent_id: str, hostname: str, active_accounts: int) -> None:
    query(
        """
        INSERT INTO agents (id, hostname, active_accounts, last_seen)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (id)
        DO UPDATE SET hostname = EXCLUDED.hostname,
                      active_accounts = EXCLUDED.active_accounts,
                      last_seen = now()
        """,
        (agent_id, hostname, active_accounts),
    )
