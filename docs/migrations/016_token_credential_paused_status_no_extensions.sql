DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'in_token_credential_status'
  ) THEN
    ALTER TYPE in_token_credential_status ADD VALUE IF NOT EXISTS 'paused';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION in_token_credentials_validate_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.status::text = OLD.status::text THEN
    RETURN NEW;
  END IF;

  IF OLD.status::text = 'active' AND NEW.status::text IN ('paused', 'rotating', 'maxed', 'expired', 'revoked') THEN
    RETURN NEW;
  END IF;

  IF OLD.status::text = 'paused' AND NEW.status::text IN ('active', 'expired', 'revoked') THEN
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

DO $$
BEGIN
  IF to_regclass('in_token_credential_events') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_in_token_credential_events_type'
      AND conrelid = 'in_token_credential_events'::regclass
  ) THEN
    ALTER TABLE in_token_credential_events
      DROP CONSTRAINT chk_in_token_credential_events_type;
  END IF;

  ALTER TABLE in_token_credential_events
    ADD CONSTRAINT chk_in_token_credential_events_type
    CHECK (
      event_type in (
        'maxed',
        'reactivated',
        'probe_failed',
        'contribution_cap_exhausted',
        'contribution_cap_cleared',
        'paused',
        'unpaused'
      )
    );
END $$;
