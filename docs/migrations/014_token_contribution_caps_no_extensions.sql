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
      AND column_name = 'five_hour_reserve_percent'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN five_hour_reserve_percent integer NOT NULL DEFAULT 0;
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
      AND column_name = 'seven_day_reserve_percent'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN seven_day_reserve_percent integer NOT NULL DEFAULT 0;
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
    FROM pg_constraint
    WHERE conname = 'chk_in_token_credentials_five_hour_reserve_percent'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD CONSTRAINT chk_in_token_credentials_five_hour_reserve_percent
      CHECK (five_hour_reserve_percent between 0 and 100);
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
    FROM pg_constraint
    WHERE conname = 'chk_in_token_credentials_seven_day_reserve_percent'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD CONSTRAINT chk_in_token_credentials_seven_day_reserve_percent
      CHECK (seven_day_reserve_percent between 0 and 100);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS in_token_credential_provider_usage (
  token_credential_id uuid PRIMARY KEY REFERENCES in_token_credentials(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  usage_source text NOT NULL,
  five_hour_utilization_ratio double precision NOT NULL,
  five_hour_resets_at timestamptz,
  seven_day_utilization_ratio double precision NOT NULL,
  seven_day_resets_at timestamptz,
  raw_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (five_hour_utilization_ratio between 0 and 1),
  CHECK (seven_day_utilization_ratio between 0 and 1)
);

CREATE INDEX IF NOT EXISTS idx_in_token_credential_provider_usage_provider_fetched_at
  ON in_token_credential_provider_usage (provider, fetched_at desc);
