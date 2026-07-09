-- Per-post reaction count range ("below to high"). When react_max > 0 the agent
-- picks a random number of userbots in [react_min, react_max] to react to each
-- post instead of using the whole pool. When both are 0, every logged-in userbot
-- reacts (the original behavior).
--
-- Note: reaction_targets.chat_id already exists (added in 003). The website now
-- lets you set it when adding a channel so detection is instant/reliable.

ALTER TABLE reaction_targets ADD COLUMN IF NOT EXISTS react_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reaction_targets ADD COLUMN IF NOT EXISTS react_max INTEGER NOT NULL DEFAULT 0;
