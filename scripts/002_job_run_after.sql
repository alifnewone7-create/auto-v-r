-- Durable, delayed retries for jobs (esp. profile updates hitting Telegram
-- FloodWait rate limits). A job can be rescheduled by setting status back to
-- 'queued' with run_after in the future; the worker only claims jobs whose
-- run_after has passed.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ NOT NULL DEFAULT now();

-- Speeds up the claim query which filters on (status, run_after) and orders by
-- created_at. Partial index keeps it small since only 'queued' rows are claimed.
CREATE INDEX IF NOT EXISTS jobs_queued_runafter_idx
  ON jobs (run_after, created_at)
  WHERE status = 'queued';
