DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
      AND column_name = 'preferred_provider'
  ) THEN
    ALTER TABLE in_api_keys
      ADD COLUMN preferred_provider text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
      AND column_name = 'provider_preference_updated_at'
  ) THEN
    ALTER TABLE in_api_keys
      ADD COLUMN provider_preference_updated_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_api_keys'
      AND column_name = 'preferred_provider'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_in_api_keys_preferred_provider'
  ) THEN
    ALTER TABLE in_api_keys
      ADD CONSTRAINT chk_in_api_keys_preferred_provider
      CHECK (preferred_provider IS NULL OR preferred_provider IN ('anthropic', 'openai'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_api_keys_buyer_preferred_provider
  ON in_api_keys (scope, preferred_provider)
  WHERE scope = 'buyer_proxy';
