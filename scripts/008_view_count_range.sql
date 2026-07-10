-- Per-post view count range ("low to high"). When view_max > 0 the agent picks
-- a random number of userbots in [view_min, view_max] to view each post instead
-- of using the whole pool. When both are 0, every logged-in userbot views the
-- post (the original behavior). This mirrors reaction_targets.react_min/max so
-- Live View can climb a post's view count gradually, just like reactions.

ALTER TABLE view_targets ADD COLUMN IF NOT EXISTS view_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE view_targets ADD COLUMN IF NOT EXISTS view_max INTEGER NOT NULL DEFAULT 0;
