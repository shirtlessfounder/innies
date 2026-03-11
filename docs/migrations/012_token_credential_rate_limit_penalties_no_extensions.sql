DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'consecutive_rate_limit_count'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN consecutive_rate_limit_count integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'last_rate_limited_at'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN last_rate_limited_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'rate_limited_until'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN rate_limited_until timestamptz;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_token_credentials_rate_limited_until
  ON in_token_credentials (status, rate_limited_until, provider);
