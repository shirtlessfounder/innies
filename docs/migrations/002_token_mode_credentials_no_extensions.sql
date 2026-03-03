-- =========================================================
-- Headroom C1 token-mode credential schema (no extensions)
-- PostgreSQL 15+
-- =========================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_token_auth_scheme') THEN
    CREATE TYPE hr_token_auth_scheme AS ENUM ('x_api_key', 'bearer');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hr_token_credential_status') THEN
    CREATE TYPE hr_token_credential_status AS ENUM ('active', 'rotating', 'expired', 'revoked');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS hr_token_credentials (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES hr_orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  auth_scheme hr_token_auth_scheme NOT NULL DEFAULT 'x_api_key',
  encrypted_access_token bytea NOT NULL,
  encrypted_refresh_token bytea,
  expires_at timestamptz NOT NULL,
  status hr_token_credential_status NOT NULL DEFAULT 'active',
  rotation_version int NOT NULL,
  rotated_at timestamptz,
  last_refresh_at timestamptz,
  last_refresh_error text,
  revoked_at timestamptz,
  created_by uuid REFERENCES hr_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, rotation_version),
  CHECK (rotation_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_token_credentials_active
  ON hr_token_credentials(org_id, provider)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_hr_token_credentials_org_provider_status
  ON hr_token_credentials(org_id, provider, status, updated_at DESC);

CREATE OR REPLACE FUNCTION hr_token_credentials_validate_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('rotating', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'rotating' AND NEW.status IN ('active', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'expired' AND NEW.status = 'revoked' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid token credential status transition: % -> %', OLD.status, NEW.status;
END;
$$;

CREATE OR REPLACE FUNCTION hr_token_credentials_enforce_rotation_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  max_version int;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.rotation_version <> OLD.rotation_version THEN
    IF NEW.rotation_version <> OLD.rotation_version + 1 THEN
      RAISE EXCEPTION 'rotation_version update must increment by exactly 1';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT max(rotation_version)
      INTO max_version
      FROM hr_token_credentials
     WHERE org_id = NEW.org_id
       AND provider = NEW.provider;

    IF max_version IS NULL THEN
      IF NEW.rotation_version <> 1 THEN
        RAISE EXCEPTION 'first rotation_version must be 1 for org/provider';
      END IF;
    ELSIF NEW.rotation_version <= max_version THEN
      RAISE EXCEPTION 'rotation_version must be strictly increasing for org/provider';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_token_credentials_set_updated_at ON hr_token_credentials;
CREATE TRIGGER trg_hr_token_credentials_set_updated_at
BEFORE UPDATE ON hr_token_credentials
FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_token_credentials_validate_transition ON hr_token_credentials;
CREATE TRIGGER trg_hr_token_credentials_validate_transition
BEFORE UPDATE ON hr_token_credentials
FOR EACH ROW EXECUTE FUNCTION hr_token_credentials_validate_transition();

DROP TRIGGER IF EXISTS trg_hr_token_credentials_rotation_version ON hr_token_credentials;
CREATE TRIGGER trg_hr_token_credentials_rotation_version
BEFORE INSERT OR UPDATE ON hr_token_credentials
FOR EACH ROW EXECUTE FUNCTION hr_token_credentials_enforce_rotation_version();

COMMIT;
