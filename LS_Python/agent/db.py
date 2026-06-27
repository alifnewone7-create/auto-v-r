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

import json
import os
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

# DATABASE_URL is the Neon connection string. Same value as the website's env.
DATABASE_URL = os.environ.get("DATABASE_URL", "")


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
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return []
            return cur.fetchall()


def query_one(sql: str, params: tuple = ()) -> Optional[dict[str, Any]]:
    rows = query(sql, params)
    return rows[0] if rows else None


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
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT %s
                )
                RETURNING *
                """,
                (limit,),
            )
            return cur.fetchall()


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


# ---------------------------------------------------------------------------
# Account helpers
# ---------------------------------------------------------------------------

def get_account(account_id: int) -> Optional[dict[str, Any]]:
    return query_one("SELECT * FROM telegram_accounts WHERE id = %s", (account_id,))


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
    query(
        """
        INSERT INTO livestream_participants (target_id, account_id, status, last_error)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (target_id, account_id)
        DO UPDATE SET status = EXCLUDED.status, last_error = EXCLUDED.last_error, updated_at = now()
        """,
        (target_id, account_id, status, error),
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
