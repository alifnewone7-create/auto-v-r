-- =============================================================================
-- Review / Direct-Message campaigns
-- =============================================================================
-- Userbots send text + image/video messages directly to ONE target Telegram
-- user. Each "number" in the panel's list = one userbot (the 1st, 2nd, ...
-- logged-in account). Every account sends its own ordered sequence of steps
-- (separate text messages, grouped image albums, or videos).
--
-- Media is stored base64 in message_assets (same pattern as profile_assets), so
-- the Python agent reads the bytes straight from the DB — no blob storage needed.
-- =============================================================================

-- Uploaded media for DM campaigns (base64). Supports image AND video. ----------
CREATE TABLE IF NOT EXISTS message_assets (
  id         SERIAL PRIMARY KEY,
  data       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'image/jpeg',
  kind       TEXT NOT NULL DEFAULT 'image',   -- image | video
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One campaign = one target user, messaged by the first N logged-in accounts. --
CREATE TABLE IF NOT EXISTS message_campaigns (
  id           SERIAL PRIMARY KEY,
  target_link  TEXT NOT NULL,
  target_title TEXT,
  status       TEXT NOT NULL DEFAULT 'sending',  -- sending | done | partial | failed
  total_count  INTEGER NOT NULL DEFAULT 0,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per account (per list number) in a campaign. `steps` is the ordered
-- sequence this account sends. Each step is one of:
--   { "kind": "text",  "text": "..." }
--   { "kind": "album", "asset_ids": [1,2,3] }   -- 1 id = single photo, >1 = album
--   { "kind": "video", "asset_ids": [5] }
CREATE TABLE IF NOT EXISTS message_sends (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,                 -- 1-based number from the list
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_sends_campaign_idx ON message_sends (campaign_id);
CREATE INDEX IF NOT EXISTS message_campaigns_created_idx ON message_campaigns (created_at DESC);
