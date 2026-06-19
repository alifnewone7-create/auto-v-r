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
