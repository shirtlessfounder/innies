BEGIN;

DO $$
BEGIN
  IF to_regclass('in_request_log') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE in_request_log
    ADD COLUMN IF NOT EXISTS proxied_path text;

  ALTER TABLE in_request_log
    ADD COLUMN IF NOT EXISTS request_content_type text;

  ALTER TABLE in_request_log
    ADD COLUMN IF NOT EXISTS response_content_type text;
END $$;

COMMIT;
