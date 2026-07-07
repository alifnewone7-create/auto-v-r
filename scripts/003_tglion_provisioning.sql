-- tg-lion auto-provisioning support.
-- Idempotent: safe to run multiple times. Mirrors the columns added in lib/db.ts.
--
-- source            : 'manual' | 'tglion' — how the account entered the system.
-- country_code      : tg-lion country code the number was purchased from (e.g. 'uz').
-- tglion_pass       : the CURRENT cloud (2FA) password tg-lion hands back with the
--                     login code. Transient — cleared after we disable/replace it.
-- two_step_password : the NEW 2FA password WE set on the account and keep control of.

ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS source            TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS country_code      TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS tglion_pass       TEXT;
ALTER TABLE telegram_accounts ADD COLUMN IF NOT EXISTS two_step_password TEXT;
