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
