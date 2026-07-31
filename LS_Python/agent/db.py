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
from contextlib import contextmanager
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

# DATABASE_URL is the Neon connection string. Same value as the website's env.
DATABASE_URL = os.environ.get("DATABASE_URL", "")


# ---------------------------------------------------------------------------
# File-descriptor limit — the fix for [Errno 24] "Too many open files"
# ---------------------------------------------------------------------------
# Each live userbot holds a Telegram TCP client PLUS a PyTgCalls WebRTC
# connection (several sockets each). With hundreds of accounts that easily blows
# past Linux's default soft limit of 1024 open files. Once we run out of FDs the
# process can't open ANY new socket, so DNS resolution, new DB connections and
# pytgcalls keepalives all start failing at once — which is exactly the log
# cascade (failed to resolve host / connection is bad / socket.send() raised
# exception) that makes live-stream members drop. Raising the soft limit to the
# hard maximum gives us the thousands of FDs a large fleet legitimately needs.
def raise_fd_limit() -> None:
    try:
        import resource  # POSIX only; absent on Windows dev machines.
    except Exception:
        return
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        # Aim high; cap the request when the hard limit is "unlimited".
        desired = hard if hard != resource.RLIM_INFINITY else 1_048_576
        if soft < desired:
            try:
                resource.setrlimit(resource.RLIMIT_NOFILE, (desired, hard))
            except (ValueError, OSError):
                # Some kernels reject jumping straight to the hard max; step down
                # until one is accepted so we still gain as much headroom as we can.
                for target in (65536, 32768, 16384, 8192, 4096):
                    if target <= soft:
                        break
                    try:
                        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
                        break
                    except (ValueError, OSError):
                        continue
        new_soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
        print(f"[db] open-file limit: {soft} -> {new_soft}")
    except Exception as e:
        print(f"[db] could not raise open-file limit ({e}); large fleets may hit 'Too many open files'.")


# Apply as early as possible: db is imported before any userbot/PyTgCalls sockets
# are created, so the higher limit is in effect for the whole process.
raise_fd_limit()

# ---------------------------------------------------------------------------
# Sharding — spread the userbots across several worker PROCESSES
# ---------------------------------------------------------------------------
# Each account has a stable integer id. A shard "owns" an account when
#     account_id % shard_count == shard_index
# so every account (and therefore its persistent WebRTC live-stream connection)
# lives in exactly ONE process. This is what stops "join then drop": hundreds of
# WebRTC keepalives no longer fight over a single event loop.
#
# FAN-OUT jobs (view_post / react_post / leave_livestream_all) must act on EVERY
# bot, not just one shard's. They are enqueued (by the website AND the worker)
# as a single plain row with NO shard_index. Shard 0 then "expands" each into one
# copy PER shard (tagging payload.shard_index), and each shard runs its copy
# against its own local bots. The originating code needs to know nothing about
# shards, so the website stays completely shard-agnostic.
# check_frozen is fanned out too: a global health scan must reach EVERY shard's
# bots, not just the one shard that happens to claim the job (which would only
# probe ~1/N of the fleet and report the rest as untouched).
FANOUT_JOB_TYPES = ("view_post", "react_post", "leave_livestream_all", "check_frozen")

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


@contextmanager
def _acquire():
    """
    Yield a DB connection, ALWAYS preferring the warm pool. This is the single
    place every query/claim/expand goes through, so the whole agent shares a
    bounded set of connections (<= AGENT_DB_POOL_MAX) instead of opening a fresh
    TCP+TLS socket per call. Bypassing the pool on the hot polling path was what
    added constant FD churn and froze the event loop on handshakes. Falls back to
    a per-call connection only when psycopg_pool isn't installed.
    """
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and paste your "
            "Neon connection string (the same one the website uses)."
        )
    pool = _get_pool()
    if pool is not None:
        with pool.connection() as conn:
            yield conn
    else:
        with _connect() as conn:
            yield conn


def query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with _acquire() as conn:
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
    with _acquire() as conn:
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


def claim_next_jobs(
    limit: int = 50,
    shard_index: int = 0,
    shard_count: int = 1,
) -> list[dict[str, Any]]:
    """
    Atomically grab up to `limit` of the oldest queued jobs THIS shard is
    responsible for, and mark them 'processing' in a single round-trip. This lets
    the worker run many jobs (e.g. 100 livestream joins) concurrently instead of
    one-at-a-time. FOR UPDATE SKIP LOCKED keeps this safe across every process.

    Shard routing (only when shard_count > 1):
      * per-account jobs  -> the shard that owns the account (account_id % N == i)
      * fan-out jobs       -> the copy tagged for this shard (shard 0 expands them
                              first; see expand_fanout_jobs)
      * misc no-account jobs (e.g. buy_tglion_batch) -> shard 0

    With the default shard_count == 1 the WHERE collapses to "everything", so a
    single-process deployment behaves exactly as before.
    """
    if limit < 1:
        limit = 1
    if shard_count < 1:
        shard_count = 1

    with _acquire() as conn:
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
                      AND (
                        -- single-process mode: take everything
                        %(sc)s <= 1
                        -- fan-out copy that was tagged for me
                        OR (
                          type = ANY(%(fanout)s)
                          AND payload ? 'shard_index'
                          AND (payload->>'shard_index')::int = %(si)s
                        )
                        -- per-account job for an account this shard owns.
                        -- Skip it while that account is cooling down (a Telegram
                        -- flood wait or a per-account pacing delay): the job stays
                        -- queued and is picked up on a later poll once the cooldown
                        -- passes. This is what isolates one account's flood wait so
                        -- it never blocks the other accounts. We also refuse to
                        -- claim a second job for an account that already has one in
                        -- flight, so each account runs its jobs strictly one by one.
                        OR (
                          account_id IS NOT NULL
                          AND (account_id %% %(sc)s) = %(si)s
                          AND NOT EXISTS (
                            SELECT 1 FROM telegram_accounts a
                            WHERE a.id = jobs.account_id
                              AND a.cooldown_until IS NOT NULL
                              AND a.cooldown_until > now()
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM jobs j2
                            WHERE j2.account_id = jobs.account_id
                              AND j2.status = 'processing'
                          )
                        )
                        -- misc no-account, non-fanout job -> shard 0 handles it
                        OR (
                          account_id IS NULL
                          AND type <> ALL(%(fanout)s)
                          AND %(si)s = 0
                        )
                      )
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT %(lim)s
                )
                RETURNING *
                """,
                {
                    "sc": shard_count,
                    "si": shard_index,
                    "fanout": list(FANOUT_JOB_TYPES),
                    "lim": limit,
                },
            )
            return cur.fetchall()


def expand_fanout_jobs(shard_count: int) -> int:
    """
    Turn every un-sharded fan-out job into one copy PER shard.

    Fan-out actions (view_post / react_post / leave_livestream_all) are enqueued
    as a single plain row so the website and the worker's detectors never need to
    know how many shards exist. This function — run ONLY by shard 0 — finds those
    rows and replaces each with `shard_count` copies, tagging payload.shard_index
    0..N-1. Each shard then claims its own copy and runs it against its own local
    bots, so the action still reaches all userbots even though they are spread
    across processes. No-op (returns 0) in single-process mode. Returns how many
    template rows were expanded.
    """
    if shard_count <= 1:
        return 0
    with _acquire() as conn:
        with conn.cursor() as cur:
            # Lock a batch of un-tagged fan-out templates so two shard-0 restarts
            # can't double-expand the same row.
            cur.execute(
                """
                SELECT id, type, account_id, payload, run_after, created_at
                FROM jobs
                WHERE status = 'queued'
                  AND type = ANY(%s)
                  AND NOT (payload ? 'shard_index')
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 500
                """,
                (list(FANOUT_JOB_TYPES),),
            )
            templates = cur.fetchall()
            if not templates:
                return 0

            for t in templates:
                base_payload = t["payload"] or {}
                # One queued copy per shard, preserving the original timing/order.
                for k in range(shard_count):
                    copy_payload = {**base_payload, "shard_index": k}
                    cur.execute(
                        """
                        INSERT INTO jobs
                            (type, account_id, payload, status, run_after, created_at, updated_at)
                        VALUES (%s, %s, %s::jsonb, 'queued', %s, %s, now())
                        """,
                        (
                            t["type"],
                            t["account_id"],
                            json.dumps(copy_payload),
                            t["run_after"],
                            t["created_at"],
                        ),
                    )

            cur.execute(
                "DELETE FROM jobs WHERE id = ANY(%s)",
                ([t["id"] for t in templates],),
            )
            return len(templates)


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
    "join_channel",
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


def set_account_cooldown(
    account_id: int,
    seconds: float,
    reason: str | None = None,
    is_flood: bool = False,
) -> None:
    """
    Put ONE account to sleep for `seconds`. While cooling down, claim_next_jobs
    will not hand this account any new per-account job, so a flood wait (or a
    deliberate pacing delay) on one account never stalls the other ~250.

    is_flood=True also records flood_until separately so the website can show
    "flood wait: 312s left" distinctly from an ordinary short pacing delay.
    Never shortens an existing, longer cooldown (GREATEST), so a big flood wait
    can't be wiped out by a tiny pacing delay that lands right after it.
    """
    secs = max(0.0, float(seconds))
    query(
        """
        UPDATE telegram_accounts
        SET cooldown_until = GREATEST(
                COALESCE(cooldown_until, now()),
                now() + (%s || ' seconds')::interval
            ),
            flood_until = CASE
                WHEN %s THEN GREATEST(
                    COALESCE(flood_until, now()),
                    now() + (%s || ' seconds')::interval
                )
                ELSE flood_until
            END,
            last_error = COALESCE(%s, last_error),
            last_action_at = now(),
            updated_at = now()
        WHERE id = %s
        """,
        (secs, is_flood, secs, reason, account_id),
    )


def note_account_action(account_id: int, cooldown_seconds: float = 0.0) -> None:
    """
    Record that an account just made a Telegram request, and optionally start a
    short pacing cooldown before its next per-account job. Called after every
    successful per-account action so the fleet self-paces.
    """
    secs = max(0.0, float(cooldown_seconds))
    if secs > 0:
        query(
            """
            UPDATE telegram_accounts
            SET last_action_at = now(),
                cooldown_until = GREATEST(
                    COALESCE(cooldown_until, now()),
                    now() + (%s || ' seconds')::interval
                ),
                updated_at = now()
            WHERE id = %s
            """,
            (secs, account_id),
        )
    else:
        query(
            "UPDATE telegram_accounts SET last_action_at = now(), updated_at = now() WHERE id = %s",
            (account_id,),
        )


def clear_account_cooldown(account_id: int) -> None:
    """Lift any cooldown/flood wait on an account (e.g. once it succeeds again)."""
    query(
        "UPDATE telegram_accounts SET cooldown_until = NULL, flood_until = NULL, updated_at = now() WHERE id = %s",
        (account_id,),
    )


def reserve_paced_slot(gap_seconds: float) -> float:
    """
    Reserve the next GLOBAL action-start slot, shared across every shard.

    All worker shards call this before starting a per-account action. It bumps a
    single shared timestamp (agent_pacing.next_start_at) forward by `gap_seconds`
    in ONE atomic statement and returns how many seconds THIS caller must wait
    before it may start. Because the row is locked for the update, two shards can
    never grab the same slot — so across the whole fleet the accounts start
    strictly one-by-one, `gap_seconds` apart, no matter how many shards run.

    Returns the wait in seconds (0 if the gate was idle / in the past).
    """
    gap = max(0.0, float(gap_seconds))
    rows = query(
        """
        WITH cur AS (
            SELECT GREATEST(next_start_at, now()) AS slot
            FROM agent_pacing
            WHERE id = 1
            FOR UPDATE
        )
        UPDATE agent_pacing p
        SET next_start_at = cur.slot + (%s || ' seconds')::interval
        FROM cur
        WHERE p.id = 1
        RETURNING EXTRACT(EPOCH FROM (cur.slot - now())) AS wait_seconds
        """,
        (gap,),
    )
    if not rows:
        return 0.0
    wait = rows[0].get("wait_seconds")
    try:
        wait = float(wait)
    except (TypeError, ValueError):
        return 0.0
    # Never wait absurdly long: if the queued backlog pushed the slot very far
    # out, cap the single wait so a shard can't appear frozen. The gate still
    # advances, so ordering is preserved.
    return max(0.0, min(wait, gap * 50 if gap > 0 else 60.0))


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
# Channel Join helpers (get userbots into a channel/group)
# ---------------------------------------------------------------------------

def channel_join_target_exists(target_id: int) -> bool:
    """
    True if the channel-join task still exists. The handler uses this to skip a
    queued join whose task was deleted from the website, so a bot is never joined
    for a task that's already gone.
    """
    return query_one("SELECT 1 AS ok FROM channel_join_targets WHERE id = %s", (target_id,)) is not None


def set_channel_join_participant(target_id: int, account_id: int, status: str, error: str | None = None) -> None:
    """
    Record one userbot's join outcome. Guarded by an EXISTS check so a late
    write for a deleted task can't violate the foreign key (mirrors the
    livestream set_participant guard).
    """
    query(
        """
        INSERT INTO channel_join_participants (target_id, account_id, status, last_error)
        SELECT %s, %s, %s, %s
        WHERE EXISTS (SELECT 1 FROM channel_join_targets WHERE id = %s)
        ON CONFLICT (target_id, account_id)
        DO UPDATE SET status = EXCLUDED.status, last_error = EXCLUDED.last_error, updated_at = now()
        """,
        (target_id, account_id, status, (error or None) and error[:500], target_id),
    )


def recount_channel_join(target_id: int) -> None:
    """
    Recompute counts + overall status from the participant rows. 'joined' and
    'already_member' both count as success. Status: joining while any are still
    pending, else done (none failed), failed (none joined) or partial.
    """
    query(
        """
        UPDATE channel_join_targets t SET
            joined_count = s.joined,
            failed_count = s.failed,
            total_count  = s.total,
            status = CASE
                       WHEN s.pending > 0 THEN 'joining'
                       WHEN s.failed = 0 THEN 'done'
                       WHEN s.joined = 0 THEN 'failed'
                       ELSE 'partial'
                     END,
            updated_at = now()
        FROM (
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('joined','already_member'))::int AS joined,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status IN ('pending','joining'))::int AS pending
            FROM channel_join_participants WHERE target_id = %s
        ) s
        WHERE t.id = %s
        """,
        (target_id, target_id),
    )


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


def enqueue_view_job(
    chat_id: int,
    message_id: int,
    target_id: int,
    view_min: int = 0,
    view_max: int = 0,
) -> None:
    """Queue a single view_post job (fans out to userbots inside the agent).

    view_min/view_max define a "low to high" range: when view_max > 0 the agent
    views from a random number of userbots in [view_min, view_max] instead of the
    whole pool, so a post's view count climbs gradually. 0/0 means every userbot
    views (the original behavior).
    """
    query(
        "INSERT INTO jobs (type, account_id, payload, status) "
        "VALUES ('view_post', NULL, %s::jsonb, 'queued')",
        (
            json.dumps(
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "target_id": target_id,
                    "view_min": view_min,
                    "view_max": view_max,
                }
            ),
        ),
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
    react_min: int = 0,
    react_max: int = 0,
) -> None:
    """Queue a single react_post job (fans out to userbots inside the agent).

    react_min/react_max define a "below to high" range: when react_max > 0 the
    agent reacts from a random number of userbots in [react_min, react_max]
    instead of the whole pool. 0/0 means every userbot reacts.
    """
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
                    "react_min": react_min,
                    "react_max": react_max,
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
# Review / Direct-Message helpers (userbots DM one target user text + media)
# ---------------------------------------------------------------------------

def get_message_send(send_id: int) -> Optional[dict[str, Any]]:
    """Fetch one message_sends row (the per-account step list for a campaign)."""
    return query_one(
        """
        SELECT s.*, c.target_link, c.target_title
          FROM message_sends s
          JOIN message_campaigns c ON c.id = s.campaign_id
         WHERE s.id = %s
        """,
        (send_id,),
    )


def get_message_asset(asset_id: int) -> Optional[dict[str, Any]]:
    """
    Fetch a stored media asset (base64 in message_assets). Returns a dict with
    raw `bytes`, `mime`, and `kind` ('image' | 'video'), or None if missing.
    """
    import base64

    row = query_one("SELECT data, mime, kind FROM message_assets WHERE id = %s", (asset_id,))
    if not row or not row.get("data"):
        return None
    return {"bytes": base64.b64decode(row["data"]), "mime": row.get("mime"), "kind": row.get("kind") or "image"}


def set_message_send(send_id: int, status: str, error: str | None = None) -> None:
    """Record the outcome of one account's DM send (pending/sending/sent/failed)."""
    query(
        "UPDATE message_sends SET status = %s, last_error = %s, updated_at = now() WHERE id = %s",
        (status, error[:500] if error else None, send_id),
    )


def recount_message_campaign(campaign_id: int) -> None:
    """
    Recompute a campaign's sent/failed counters + overall status from its send
    rows. Status: 'sending' while any row is still pending/sending, else 'done'
    (all sent), 'failed' (all failed), or 'partial' (a mix).

    As soon as the campaign becomes terminal (no send is still pending/sending)
    we free the heavy media it used: every base64 blob in message_assets that
    this campaign's sends referenced is deleted right away. The media has already
    been delivered and is never read again, so this is the main disk saver and it
    happens the moment the task finishes. The delete is idempotent, so a repeat
    call (or two shards finishing the last two sends at once) is harmless.
    """
    row = query_one(
        """
        WITH agg AS (
          SELECT
            count(*)                                   AS total,
            count(*) FILTER (WHERE status = 'sent')    AS sent,
            count(*) FILTER (WHERE status = 'failed')  AS failed,
            count(*) FILTER (WHERE status IN ('pending','sending')) AS busy
          FROM message_sends WHERE campaign_id = %s
        )
        UPDATE message_campaigns c
           SET sent_count   = agg.sent,
               failed_count = agg.failed,
               status = CASE
                          WHEN agg.busy > 0 THEN 'sending'
                          WHEN agg.failed = 0 THEN 'done'
                          WHEN agg.sent = 0 THEN 'failed'
                          ELSE 'partial'
                        END,
               updated_at = now()
          FROM agg
         WHERE c.id = %s
        RETURNING c.status
        """,
        (campaign_id, campaign_id),
    )

    # Terminal now? Drop this campaign's media assets (they're done being sent).
    if row and row.get("status") in ("done", "failed", "partial"):
        query(
            """
            DELETE FROM message_assets
             WHERE id IN (
               SELECT (aid)::int
                 FROM message_sends s,
                      jsonb_array_elements(s.steps) AS step,
                      jsonb_array_elements_text(step->'asset_ids') AS aid
                WHERE s.campaign_id = %s
                  AND step ? 'asset_ids'
             )
            """,
            (campaign_id,),
        )


def cleanup_finished_message_data(job_retention_seconds: int = 3600) -> dict[str, int]:
    """
    Periodic safety-net sweep for the Review/DM feature (run by the primary shard).
    Deletes rows that are no longer needed once work has finished:

      1. Orphan media  – any message_assets blob not referenced by ANY send.
         Covers uploads that were never sent (composer abandoned) and anything the
         per-campaign delete in recount_message_campaign happened to miss.
      2. Spent jobs     – send_dm jobs that are already 'done'/'failed' and older
         than `job_retention_seconds`. The real per-account outcome lives in
         message_sends, so these job rows carry no further value.

    Returns a small dict of how many rows were removed, for logging.
    """
    assets = query(
        """
        DELETE FROM message_assets a
         WHERE NOT EXISTS (
           SELECT 1
             FROM message_sends s,
                  jsonb_array_elements(s.steps) AS step,
                  jsonb_array_elements_text(step->'asset_ids') AS aid
            WHERE step ? 'asset_ids' AND (aid)::int = a.id
         )
        RETURNING a.id
        """
    )
    jobs = query(
        """
        DELETE FROM jobs
         WHERE type = 'send_dm'
           AND status IN ('done', 'failed')
           AND updated_at < now() - (%s || ' seconds')::interval
        RETURNING id
        """,
        (max(0, int(job_retention_seconds)),),
    )
    return {
        "assets": len(assets) if assets else 0,
        "jobs": len(jobs) if jobs else 0,
    }


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
