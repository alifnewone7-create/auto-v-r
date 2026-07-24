import { Pool } from "pg"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

// Single shared pg Pool. Both the website and the Python agent connect to the
// same Neon database using DATABASE_URL. The website writes/reads jobs; the
// Python agent (running on your local PC or VPS) polls and executes them.
declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined
  // eslint-disable-next-line no-var
  var _schemaReady: Promise<void> | undefined
}

export const pool =
  global._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  })

if (process.env.NODE_ENV !== "production") {
  global._pgPool = pool
}

// =============================================================================
// Auto-migration
// =============================================================================
// PRIMARY path: on the first DB query, ensureSchema() reads EVERY file in the
// scripts/ folder (in filename order) and runs them. All scripts are idempotent
// (IF NOT EXISTS everywhere), so the moment a Neon database is integrated the
// entire schema is applied automatically — and any new scripts/NNN_*.sql you
// drop in later is picked up on the next boot with zero extra wiring.
//
// FALLBACK path: if the scripts/ folder can't be read at runtime (e.g. it was
// not bundled into a deployment), we run this embedded copy instead so the app
// still works. Keep it roughly in sync with the scripts as a safety net.
const SCHEMA_SQL = /* sql */ `
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
  mtproto_hash        TEXT,
  login_hash          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS mtproto_hash TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS login_hash   TEXT;

-- tg-lion auto-provisioning columns -------------------------------------------
-- source: 'manual' (added by hand) or 'tglion' (bought via the tg-lion API).
-- country_code: the tg-lion country the number was bought from.
-- tglion_pass: the CURRENT 2FA password tg-lion returns with the login code
--   (transient: cleared once we've turned it off / replaced it).
-- two_step_password: the NEW 2FA password we set on the account (our own).
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS source            TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS country_code      TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS tglion_pass       TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS two_step_password TEXT;

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
CREATE TABLE IF NOT EXISTS view_targets (
  id                   SERIAL PRIMARY KEY,
  channel_link         TEXT NOT NULL UNIQUE,
  chat_id              BIGINT,
  title                TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  last_seen_message_id BIGINT NOT NULL DEFAULT 0,
  posts_viewed         INTEGER NOT NULL DEFAULT 0,
  views_sent           INTEGER NOT NULL DEFAULT 0,
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
  options         JSONB NOT NULL DEFAULT '[]'::jsonb,
  multiple_choice BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'detecting',
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vote_targets_status_idx ON vote_targets (status);

-- One row per account per poll. Enforces "each userbot votes only once per
-- poll" via the UNIQUE (target_id, account_id) constraint. Removing a vote
-- deletes the row (or marks it 'removed'), freeing that account to be reused.
CREATE TABLE IF NOT EXISTS vote_casts (
  id           SERIAL PRIMARY KEY,
  target_id    INTEGER NOT NULL REFERENCES vote_targets(id)     ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_id, account_id)
);

CREATE INDEX IF NOT EXISTS vote_casts_target_idx ON vote_casts (target_id);
CREATE INDEX IF NOT EXISTS vote_casts_target_option_idx ON vote_casts (target_id, option_index);

-- Reaction targets: channels whose FUTURE posts get auto-reacted to by userbots.
-- Each target stores the emoji set to react with and the pacing mode. The agent
-- watches the channel (same future-only baseline as view_targets), and for every
-- new post spreads the userbots' reactions over a time window so it looks human.
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

-- Incoming Telegram messages surfaced per userbot account ----------------------
-- Only messages from Telegram's official service account (id 777000, "Telegram")
-- are stored — these carry login codes and other system notices. They are
-- ephemeral: the agent deletes anything older than 30 minutes, so this table
-- only ever holds a short, rolling window of recent notices.
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

-- Channel Join: make every userbot a member of a channel/group so future
-- view/react/vote actions work. Joins are idempotent + fault-tolerant (already
-- a member counts as success; expired/wrong/banned links are skipped per-bot).
CREATE TABLE IF NOT EXISTS channel_join_targets (
  id           SERIAL PRIMARY KEY,
  chat_link    TEXT NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'joining',   -- joining | done | partial | failed
  total_count  INTEGER NOT NULL DEFAULT 0,
  joined_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_join_participants (
  target_id  INTEGER NOT NULL REFERENCES channel_join_targets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES telegram_accounts(id)    ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',    -- pending | joining | joined | already_member | failed
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, account_id)
);

CREATE INDEX IF NOT EXISTS channel_join_targets_status_idx ON channel_join_targets (status);
CREATE INDEX IF NOT EXISTS channel_join_participants_target_idx ON channel_join_participants (target_id);

-- Review / Direct-Message campaigns: userbots DM text + image/video to one user.
-- Media is stored base64 in message_assets (same pattern as profile_assets) so
-- the Python agent reads bytes straight from the DB (no blob storage needed).
CREATE TABLE IF NOT EXISTS message_assets (
  id         SERIAL PRIMARY KEY,
  data       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'image/jpeg',
  kind       TEXT NOT NULL DEFAULT 'image',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_campaigns (
  id           SERIAL PRIMARY KEY,
  target_link  TEXT NOT NULL,
  target_title TEXT,
  status       TEXT NOT NULL DEFAULT 'sending',
  total_count  INTEGER NOT NULL DEFAULT 0,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_sends (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending',
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_sends_campaign_idx ON message_sends (campaign_id);
CREATE INDEX IF NOT EXISTS message_campaigns_created_idx ON message_campaigns (created_at DESC);
`

// Reads every scripts/*.sql file in filename order and returns them as an
// ordered list of { name, sql }. Returns null if the folder can't be read, so
// the caller can fall back to the embedded SCHEMA_SQL.
function loadScriptMigrations(): { name: string; sql: string }[] | null {
  try {
    const dir = join(process.cwd(), "scripts")
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".sql"))
      .sort() // 001_, 002_, ... apply in order
    if (files.length === 0) return null
    return files.map((name) => ({
      name,
      sql: readFileSync(join(dir, name), "utf8"),
    }))
  } catch {
    return null
  }
}

// Applies the whole schema. Prefers the scripts/ folder (so new SQL files are
// picked up automatically); falls back to the embedded SCHEMA_SQL if the folder
// isn't available at runtime. Every statement is idempotent, so re-running is
// always safe.
async function applySchema(): Promise<void> {
  const migrations = loadScriptMigrations()
  if (migrations) {
    for (const { name, sql } of migrations) {
      try {
        await pool.query(sql)
        console.log(`[v0] Applied migration: ${name}`)
      } catch (err: any) {
        console.log(`[v0] Migration ${name} failed:`, err?.message)
        throw err
      }
    }
    console.log(`[v0] Database schema ensured from ${migrations.length} script(s)`)
    return
  }
  // Fallback: scripts/ folder not readable — use the embedded copy.
  await pool.query(SCHEMA_SQL)
  console.log("[v0] Database schema ensured (embedded fallback)")
}

// Runs the schema exactly once per process. The cached promise guarantees that
// concurrent requests don't race to create tables — they all await the same
// migration. If it fails, the promise is reset so the next query retries.
export function ensureSchema(): Promise<void> {
  if (!global._schemaReady) {
    global._schemaReady = applySchema().catch((err) => {
      // Reset so a later request can retry (e.g. transient connection error).
      global._schemaReady = undefined
      console.log("[v0] ensureSchema failed:", err?.message)
      throw err
    })
  }
  return global._schemaReady
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  await ensureSchema()
  const res = await pool.query(text, params)
  return res.rows as T[]
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}
