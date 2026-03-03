-- =========================================================
-- Headroom C1.2: weekly contribution limits per token credential
-- =========================================================

BEGIN;

ALTER TABLE hr_token_credentials
  ADD COLUMN IF NOT EXISTS weekly_contribution_limit_units bigint,
  ADD COLUMN IF NOT EXISTS weekly_contribution_used_units bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_window_start_at timestamptz NOT NULL DEFAULT (date_trunc('week', now() at time zone 'utc') at time zone 'utc');

UPDATE hr_token_credentials
SET
  weekly_contribution_used_units = COALESCE(weekly_contribution_used_units, 0),
  weekly_window_start_at = COALESCE(weekly_window_start_at, (date_trunc('week', now() at time zone 'utc') at time zone 'utc'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_hr_token_credentials_weekly_limit_non_negative'
  ) THEN
    ALTER TABLE hr_token_credentials
      ADD CONSTRAINT chk_hr_token_credentials_weekly_limit_non_negative
      CHECK (weekly_contribution_limit_units IS NULL OR weekly_contribution_limit_units >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_hr_token_credentials_weekly_used_non_negative'
  ) THEN
    ALTER TABLE hr_token_credentials
      ADD CONSTRAINT chk_hr_token_credentials_weekly_used_non_negative
      CHECK (weekly_contribution_used_units >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hr_token_credentials_weekly_window
  ON hr_token_credentials (org_id, provider, status, weekly_window_start_at);

COMMIT;
