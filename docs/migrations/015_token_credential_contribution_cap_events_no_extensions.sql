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
        'contribution_cap_cleared'
      )
    );
END $$;
