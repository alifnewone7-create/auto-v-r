import { Pool } from "pg"

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
// Auto-migration — keep this in sync with scripts/001_init_schema.sql
// =============================================================================
// This is the SINGLE source of truth that runs automatically the first time the
// app touches the database. It is fully idempotent (IF NOT EXISTS everywhere),
// so the moment a Neon database is integrated/connected, every table is created
// on the first query — no manual script run required.
//
// IMPORTANT: whenever you add a new table/column/index in the future, add it
// here (and mirror it in scripts/001_init_schema.sql) using IF NOT EXISTS so it
// stays automatic and safe to re-run.
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
`

// Runs the schema exactly once per process. The cached promise guarantees that
// concurrent requests don't race to create tables — they all await the same
// migration. If it fails, the promise is reset so the next query retries.
export function ensureSchema(): Promise<void> {
  if (!global._schemaReady) {
    global._schemaReady = pool
      .query(SCHEMA_SQL)
      .then(() => {
        console.log("[v0] Database schema ensured (tables created if missing)")
      })
      .catch((err) => {
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
