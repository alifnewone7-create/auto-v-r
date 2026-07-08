-- Live-stream stats surfaced in the panel: which channel currently has a live
-- stream running and how many users (total, across everyone — not just our
-- userbots) are in it. Populated by the agent when it joins and refreshed
-- periodically while the stream is active. All idempotent.

ALTER TABLE livestream_targets ADD COLUMN IF NOT EXISTS chat_id           BIGINT;
ALTER TABLE livestream_targets ADD COLUMN IF NOT EXISTS live_active       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE livestream_targets ADD COLUMN IF NOT EXISTS live_participants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE livestream_targets ADD COLUMN IF NOT EXISTS live_checked_at   TIMESTAMPTZ;
