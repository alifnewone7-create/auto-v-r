-- =============================================================================
-- Channel Join — make every userbot a member of a channel / group
-- =============================================================================
-- Userbots must already be members of a chat before they can view / react /
-- vote reliably. This feature lets you paste one channel/group link and queue a
-- join for every logged-in userbot. Joins are idempotent and fault-tolerant:
--   * already a member        -> counted as success (never an error)
--   * expired / wrong / bad link, no permission, banned -> that userbot is
--     skipped with a clear per-bot reason; the agent never crashes
-- Safe to run any time (idempotent, IF NOT EXISTS everywhere).
-- =============================================================================

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
