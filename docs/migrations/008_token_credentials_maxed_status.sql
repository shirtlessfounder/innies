DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'in_token_credential_status'
  ) THEN
    ALTER TYPE in_token_credential_status ADD VALUE IF NOT EXISTS 'maxed';
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
      AND column_name = 'consecutive_failure_count'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN consecutive_failure_count integer NOT NULL DEFAULT 0;
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
      AND column_name = 'last_failed_status'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN last_failed_status integer;
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
      AND column_name = 'last_failed_at'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN last_failed_at timestamptz;
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
      AND column_name = 'maxed_at'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN maxed_at timestamptz;
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
      AND column_name = 'next_probe_at'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN next_probe_at timestamptz;
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
      AND column_name = 'last_probe_at'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN last_probe_at timestamptz;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_token_credentials_probe_due
  ON in_token_credentials (provider, status, next_probe_at);

CREATE OR REPLACE FUNCTION in_token_credentials_validate_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.status::text = OLD.status::text THEN
    RETURN NEW;
  END IF;

  IF OLD.status::text = 'active' AND NEW.status::text IN ('rotating', 'maxed', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.status::text = 'rotating' AND NEW.status::text IN ('active', 'maxed', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.status::text = 'maxed' AND NEW.status::text IN ('active', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.status::text = 'expired' AND NEW.status::text = 'revoked' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid token credential status transition: % -> %', OLD.status, NEW.status;
END;
$$;
