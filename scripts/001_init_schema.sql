-- =============================================================================
-- Telegram Userbot — Database Schema (idempotent)
-- =============================================================================
-- Safe to run any time on any Neon database. Uses IF NOT EXISTS everywhere so
-- it will set up a fresh DB and leave an already-configured DB untouched.
-- Run this whenever a new Neon database is integrated/connected.
-- =============================================================================

-- Telegram accounts (userbots) managed by the panel ---------------------------
CREATE TABLE IF NOT EXISTS telegram_accounts (
  id                  SERIAL PRIMARY KEY,
  label               TEXT,
  phone_number        TEXT UNIQUE NOT NULL,
  app_title           TEXT NOT NULL DEFAULT 'Iamhear',
  short_name          TEXT NOT NULL DEFAULT 'iamheardeveloper',
  api_id              TEXT,
  api_hash            TEXT,
  session_string      TEXT,
  status              TEXT NOT NULL DEFAULT 'new',
  two_factor_required BOOLEAN NOT NULL DEFAULT false,
  last_error          TEXT,
  -- login state used by the Python agent during the multi-step login flow
  mtproto_hash        TEXT,
  login_hash          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- In case the table already existed without the agent login columns -----------
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS mtproto_hash TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS login_hash   TEXT;

-- Job queue (website enqueues, Python agent claims & executes) -----------------
CREATE TABLE IF NOT EXISTS jobs (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  account_id  INTEGER,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'queued',
  result      JSONB,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_account_id_idx     ON jobs (account_id);

-- Livestream / group targets ---------------------------------------------------
CREATE TABLE IF NOT EXISTS livestream_targets (
  id           SERIAL PRIMARY KEY,
  chat_link    TEXT NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'idle',
  joined_count INTEGER NOT NULL DEFAULT 0,
  total_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which accounts participate in which livestream target ------------------------
CREATE TABLE IF NOT EXISTS livestream_participants (
  target_id  INTEGER NOT NULL REFERENCES livestream_targets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES telegram_accounts(id)  ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, account_id)
);

-- Agent heartbeat registry (website reads this to show "agent online") ---------
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  hostname        TEXT,
  active_accounts INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Live View targets: channels whose future posts get auto-viewed by userbots ---
-- The Python agent watches each active channel (live handler + polling fallback)
-- and, when a NEW post appears, dispatches a view_post job for every logged-in
-- userbot. Only posts newer than last_seen_message_id are viewed (clean cutoff).
CREATE TABLE IF NOT EXISTS view_targets (
  id                   SERIAL PRIMARY KEY,
  channel_link         TEXT NOT NULL UNIQUE,
  chat_id              BIGINT,
  title                TEXT,
  status               TEXT NOT NULL DEFAULT 'active',  -- active | paused
  last_seen_message_id BIGINT NOT NULL DEFAULT 0,
  posts_viewed         INTEGER NOT NULL DEFAULT 0,       -- distinct posts processed
  views_sent           INTEGER NOT NULL DEFAULT 0,       -- total view jobs dispatched
  last_post_at         TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS view_targets_status_idx ON view_targets (status);
