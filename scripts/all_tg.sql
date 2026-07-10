-- =============================================================================
-- Telegram Userbot — Complete Database Schema (idempotent, all-in-one)
-- =============================================================================
-- This file is the merged copy of every migration in scripts/ (001–008),
-- combined into a single script. Safe to run any time on any Neon database.
-- Uses IF NOT EXISTS everywhere so it will set up a fresh DB and leave an
-- already-configured DB untouched.
--
-- NOTE: You normally do NOT need to run this manually. The app auto-creates all
-- tables on the first database query (see SCHEMA_SQL / ensureSchema in
-- lib/db.ts). This file is the mirrored, human-readable copy. Whenever you add
-- a new table/column/index, update BOTH this file and SCHEMA_SQL in lib/db.ts
-- (always with IF NOT EXISTS) so creation stays automatic on integration.
-- =============================================================================


-- =============================================================================
-- 001_init_schema.sql — base schema
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

-- Vote targets: a Telegram poll (in a public/private channel) we want to vote on
-- The agent detects the most recent poll in the channel and fills in the
-- question/options/poll_id/chat_id/message_id, then the panel casts votes.
CREATE TABLE IF NOT EXISTS vote_targets (
  id              SERIAL PRIMARY KEY,
  poll_link       TEXT NOT NULL,
  chat_id         BIGINT,
  message_id      BIGINT,
  poll_id         TEXT,
  question        TEXT,
  options         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ index, text }]
  multiple_choice BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'detecting',    -- detecting | ready | failed
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vote_targets_status_idx ON vote_targets (status);

-- One row per account per poll. Enforces "each userbot votes only once per
-- poll" via the UNIQUE (target_id, account_id) constraint. Removing a vote
-- deletes the row, freeing that account to be reused on the same poll.
CREATE TABLE IF NOT EXISTS vote_casts (
  id           SERIAL PRIMARY KEY,
  target_id    INTEGER NOT NULL REFERENCES vote_targets(id)      ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | voted | removing | failed
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_id, account_id)
);

CREATE INDEX IF NOT EXISTS vote_casts_target_idx ON vote_casts (target_id);
CREATE INDEX IF NOT EXISTS vote_casts_target_option_idx ON vote_casts (target_id, option_index);

-- Reaction targets: channels whose FUTURE posts get auto-reacted to by userbots.
--   mode: 'slow' | 'medium' | 'fast' | 'custom'
--   custom_minutes: only used when mode = 'custom'; the exact window (>= 1 min)
--   emojis: JSON array of emoji strings, e.g. ["👍","🔥","❤️"]
CREATE TABLE IF NOT EXISTS reaction_targets (
  id                   SERIAL PRIMARY KEY,
  channel_link         TEXT NOT NULL UNIQUE,
  chat_id              BIGINT,
  title                TEXT,
  emojis               JSONB NOT NULL DEFAULT '[]'::jsonb,
  mode                 TEXT NOT NULL DEFAULT 'medium',
  custom_minutes       INTEGER NOT NULL DEFAULT 5,
  status               TEXT NOT NULL DEFAULT 'active',
  last_seen_message_id BIGINT NOT NULL DEFAULT 0,
  posts_reacted        INTEGER NOT NULL DEFAULT 0,
  reactions_sent       INTEGER NOT NULL DEFAULT 0,
  last_post_at         TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reaction_targets_status_idx ON reaction_targets (status);

-- Profile assets: uploaded profile photos (base64), shared across accounts when
-- the same image is applied to many accounts in one bulk edit. -----------------
CREATE TABLE IF NOT EXISTS profile_assets (
  id         SERIAL PRIMARY KEY,
  data       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'image/jpeg',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Profile updates: one row per account per bulk profile edit. The agent applies
-- the name / username / photo change and writes back the status so the panel can
-- show per-account progress (pending -> done / failed). ------------------------
CREATE TABLE IF NOT EXISTS profile_updates (
  id             SERIAL PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  first_name     TEXT,
  last_name      TEXT,
  username       TEXT,
  photo_asset_id INTEGER REFERENCES profile_assets(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_updates_account_idx ON profile_updates (account_id);
CREATE INDEX IF NOT EXISTS profile_updates_created_idx ON profile_updates (created_at DESC);


-- =============================================================================
-- 002_job_run_after.sql — durable, delayed retries for jobs
-- =============================================================================
-- Durable, delayed retries for jobs (esp. profile updates hitting Telegram
-- FloodWait rate limits). A job can be rescheduled by setting status back to
-- 'queued' with run_after in the future; the worker only claims jobs whose
-- run_after has passed.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ NOT NULL DEFAULT now();

-- Speeds up the claim query which filters on (status, run_after) and orders by
-- created_at. Partial index keeps it small since only 'queued' rows are claimed.
CREATE INDEX IF NOT EXISTS jobs_queued_runafter_idx
  ON jobs (run_after, created_at)
  WHERE status = 'queued';


-- =============================================================================
-- 003_tglion_provisioning.sql — tg-lion auto-provisioning support
-- =============================================================================
-- Idempotent: safe to run multiple times. Mirrors the columns added in lib/db.ts.
--
-- source            : 'manual' | 'tglion' — how the account entered the system.
-- country_code      : tg-lion country code the number was purchased from (e.g. 'uz').
-- tglion_pass       : the CURRENT cloud (2FA) password tg-lion hands back with the
--                     login code. Transient — cleared after we disable/replace it.
-- two_step_password : the NEW 2FA password WE set on the account and keep control of.

ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS source            TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS country_code      TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS tglion_pass       TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS two_step_password TEXT;


-- =============================================================================
-- 004_provision_progress.sql — live provisioning progress
-- =============================================================================
-- Live provisioning progress for tg-lion auto-buy accounts.
--
-- During the fully-automatic flow (buy number -> collect api_id/api_hash ->
-- log the userbot in) the agent now writes a human-readable step message and
-- the actual Telegram login code it read from tg-lion, so the website can show
-- the user exactly what is happening and which code was used.
--
--   provision_step  -> short status line, e.g. "Waiting for Telegram code…"
--   provision_code  -> the login code read from tg-lion (shown in the UI)
--
-- Both are cleared once the account reaches 'logged_in'. Idempotent.

ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS provision_step TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS provision_code TEXT;


-- =============================================================================
-- 005_account_messages.sql — incoming Telegram service messages
-- =============================================================================
-- Incoming Telegram messages surfaced per userbot account.
-- Only messages from Telegram's official service account (id 777000, "Telegram")
-- are stored — these carry login codes and other system notices. Messages are
-- ephemeral: the agent auto-deletes anything older than 30 minutes, so this
-- table only ever holds a short, rolling window of recent notices.

CREATE TABLE IF NOT EXISTS account_messages (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  sender              TEXT NOT NULL DEFAULT 'Telegram',
  telegram_message_id BIGINT,
  body                TEXT NOT NULL,
  message_date        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS account_messages_account_created_idx
  ON account_messages (account_id, created_at DESC);


-- =============================================================================
-- 006_reaction_count_range.sql — per-post reaction count range
-- =============================================================================
-- Per-post reaction count range ("below to high"). When react_max > 0 the agent
-- picks a random number of userbots in [react_min, react_max] to react to each
-- post instead of using the whole pool. When both are 0, every logged-in userbot
-- reacts (the original behavior).
--
-- Note: reaction_targets.chat_id already exists (added in 003). The website now
-- lets you set it when adding a channel so detection is instant/reliable.

ALTER TABLE reaction_targets ADD COLUMN IF NOT EXISTS react_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reaction_targets ADD COLUMN IF NOT EXISTS react_max INTEGER NOT NULL DEFAULT 0;


-- =============================================================================
-- 007_channel_join.sql — make every userbot a member of a channel / group
-- =============================================================================
-- Userbots must already be members of a chat before they can view / react /
-- vote reliably. This feature lets you paste one channel/group link and queue a
-- join for every logged-in userbot. Joins are idempotent and fault-tolerant:
--   * already a member        -> counted as success (never an error)
--   * expired / wrong / bad link, no permission, banned -> that userbot is
--     skipped with a clear per-bot reason; the agent never crashes
-- Safe to run any time (idempotent, IF NOT EXISTS everywhere).

-- One row per "join this chat with N userbots" task.
CREATE TABLE IF NOT EXISTS channel_join_targets (
  id           SERIAL PRIMARY KEY,
  chat_link    TEXT NOT NULL,
  title        TEXT,
  -- joining -> at least one bot still pending
  -- done     -> every bot joined / already a member
  -- partial  -> some joined, some failed
  -- failed   -> every bot failed
  status       TEXT NOT NULL DEFAULT 'joining',
  total_count  INTEGER NOT NULL DEFAULT 0,
  joined_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which userbots are joining which target, and how each one is doing.
CREATE TABLE IF NOT EXISTS channel_join_participants (
  target_id  INTEGER NOT NULL REFERENCES channel_join_targets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES telegram_accounts(id)    ON DELETE CASCADE,
  -- pending | joining | joined | already_member | failed
  status     TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, account_id)
);

CREATE INDEX IF NOT EXISTS channel_join_targets_status_idx ON channel_join_targets (status);
CREATE INDEX IF NOT EXISTS channel_join_participants_target_idx ON channel_join_participants (target_id);


-- =============================================================================
-- 008_view_count_range.sql — per-post view count range
-- =============================================================================
-- Per-post view count range ("low to high"). When view_max > 0 the agent picks
-- a random number of userbots in [view_min, view_max] to view each post instead
-- of using the whole pool. When both are 0, every logged-in userbot views the
-- post (the original behavior). This mirrors reaction_targets.react_min/max so
-- Live View can climb a post's view count gradually, just like reactions.

ALTER TABLE view_targets ADD COLUMN IF NOT EXISTS view_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE view_targets ADD COLUMN IF NOT EXISTS view_max INTEGER NOT NULL DEFAULT 0;
