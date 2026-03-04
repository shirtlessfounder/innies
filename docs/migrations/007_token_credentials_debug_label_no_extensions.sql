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
      AND column_name = 'debug_label'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD COLUMN debug_label text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_token_credentials'
      AND column_name = 'debug_label'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_in_token_credentials_debug_label_len'
  ) THEN
    ALTER TABLE in_token_credentials
      ADD CONSTRAINT chk_in_token_credentials_debug_label_len
      CHECK (debug_label IS NULL OR char_length(trim(debug_label)) BETWEEN 1 AND 64);
  END IF;
END $$;
