-- Per-account scheduling / cooldown state.
--
-- This powers the per-account delay + flood-wait isolation system:
--   * cooldown_until  -> the account may NOT be given a new per-account job until
--                        this time has passed. Set from a Telegram FloodWait (the
--                        exact seconds Telegram demanded) or a manual cooldown.
--                        claim_next_jobs skips per-account jobs whose owning
--                        account is still cooling down, so ONE account waiting
--                        never blocks the other ~250 accounts.
--   * flood_until     -> when a Telegram FloodWait specifically ends (a subset of
--                        cooldown_until, kept separately so the website can show
--                        "flood wait 312s left" vs a normal short delay).
--   * last_action_at  -> the last time this account made a Telegram request.
--                        Used for visibility ("when did this account last act")
--                        and to reason about pacing.

ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ NULL;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS flood_until TIMESTAMPTZ NULL;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ NULL;

-- Small partial index so the claim query can cheaply skip accounts that are
-- currently cooling down (only a minority of rows ever have this set).
CREATE INDEX IF NOT EXISTS telegram_accounts_cooldown_idx
  ON telegram_accounts (cooldown_until)
  WHERE cooldown_until IS NOT NULL;
