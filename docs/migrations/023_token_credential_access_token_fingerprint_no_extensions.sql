-- =========================================================
-- Headroom C4.1: token credential access-token fingerprint
-- =========================================================

BEGIN;

ALTER TABLE in_token_credentials
  ADD COLUMN IF NOT EXISTS access_token_sha256 text;

-- Existing encrypted token rows cannot be backfilled in pure SQL. Application
-- duplicate detection covers legacy rows until each credential is rewritten.
CREATE UNIQUE INDEX IF NOT EXISTS uq_in_token_credentials_access_token_sha256_active
  ON in_token_credentials (access_token_sha256)
  WHERE access_token_sha256 IS NOT NULL
    AND status <> 'revoked';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT SELECT (access_token_sha256), INSERT (access_token_sha256), UPDATE (access_token_sha256), REFERENCES (access_token_sha256)
      ON TABLE in_token_credentials TO niyant;
  END IF;
END $$;

COMMIT;
