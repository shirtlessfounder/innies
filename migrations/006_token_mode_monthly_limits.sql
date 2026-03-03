-- =========================================================
-- Innies C1.3: switch token contribution cap window from weekly to monthly
-- Requires: 005 hard cutover already applied (in_* objects exist)
-- =========================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'weekly_contribution_limit_units'
  ) THEN
    ALTER TABLE in_token_credentials
      RENAME COLUMN weekly_contribution_limit_units TO monthly_contribution_limit_units;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'weekly_contribution_used_units'
  ) THEN
    ALTER TABLE in_token_credentials
      RENAME COLUMN weekly_contribution_used_units TO monthly_contribution_used_units;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'weekly_window_start_at'
  ) THEN
    ALTER TABLE in_token_credentials
      RENAME COLUMN weekly_window_start_at TO monthly_window_start_at;
  END IF;
END $$;

-- Ensure monthly window starts at current UTC month for new rows.
ALTER TABLE in_token_credentials
  ALTER COLUMN monthly_window_start_at
  SET DEFAULT (date_trunc('month', now() at time zone 'utc') at time zone 'utc');

-- Rename constraints if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_hr_token_credentials_weekly_limit_non_negative'
  ) THEN
    EXECUTE 'ALTER TABLE in_token_credentials RENAME CONSTRAINT chk_hr_token_credentials_weekly_limit_non_negative TO chk_in_token_credentials_monthly_limit_non_negative';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_hr_token_credentials_weekly_used_non_negative'
  ) THEN
    EXECUTE 'ALTER TABLE in_token_credentials RENAME CONSTRAINT chk_hr_token_credentials_weekly_used_non_negative TO chk_in_token_credentials_monthly_used_non_negative';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_in_token_credentials_weekly_limit_non_negative'
  ) THEN
    EXECUTE 'ALTER TABLE in_token_credentials RENAME CONSTRAINT chk_in_token_credentials_weekly_limit_non_negative TO chk_in_token_credentials_monthly_limit_non_negative';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_in_token_credentials_weekly_used_non_negative'
  ) THEN
    EXECUTE 'ALTER TABLE in_token_credentials RENAME CONSTRAINT chk_in_token_credentials_weekly_used_non_negative TO chk_in_token_credentials_monthly_used_non_negative';
  END IF;
END $$;

-- Backfill any null monthly window starts safely.
UPDATE in_token_credentials
SET monthly_window_start_at = (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
WHERE monthly_window_start_at IS NULL;

-- Rename index if present, then ensure expected index exists.
ALTER INDEX IF EXISTS idx_in_token_credentials_weekly_window
  RENAME TO idx_in_token_credentials_monthly_window;

CREATE INDEX IF NOT EXISTS idx_in_token_credentials_monthly_window
  ON in_token_credentials (org_id, provider, status, monthly_window_start_at);

COMMIT;
