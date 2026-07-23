-- Global cross-shard pacing gate.
--
-- The agent runs as N sharded processes (LS_WORKER_SHARDS). Each process paces
-- its OWN per-account action starts, but that alone lets one account per shard
-- start at the same instant (a burst of N). This single shared row lets every
-- shard agree on ONE global schedule: a shard must reserve the next start slot
-- here before launching a paced action, so across the WHOLE fleet the accounts
-- start strictly one-by-one with a gap between them.
CREATE TABLE IF NOT EXISTS agent_pacing (
  id           INT PRIMARY KEY DEFAULT 1,
  next_start_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_pacing_singleton CHECK (id = 1)
);

-- Ensure the single row exists.
INSERT INTO agent_pacing (id, next_start_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;
