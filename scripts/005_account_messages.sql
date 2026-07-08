-- Incoming Telegram messages surfaced per userbot account.
-- Only messages from Telegram's official service account (id 777000, "Telegram")
-- are stored — these carry login codes and other system notices. Messages are
-- ephemeral: the agent auto-deletes anything older than 30 minutes, so this
-- table only ever holds a short, rolling window of recent notices.

CREATE TABLE IF NOT EXISTS account_messages (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  sender              TEXT NOT NULL DEFAULT 'Telegram',
  telegram_message_id BIGINT,
  body                TEXT NOT NULL,
  message_date        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS account_messages_account_created_idx
  ON account_messages (account_id, created_at DESC);
