DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_routing_events'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'in_routing_events'
      AND column_name = 'ttfb_ms'
  ) THEN
    ALTER TABLE in_routing_events
      ADD COLUMN ttfb_ms integer;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'in_routing_events'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public'
      AND table_name = 'in_routing_events'
      AND constraint_name = 'chk_in_routing_events_ttfb_non_negative'
  ) THEN
    ALTER TABLE in_routing_events
      ADD CONSTRAINT chk_in_routing_events_ttfb_non_negative
      CHECK (ttfb_ms is null or ttfb_ms >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_in_routing_events_ttfb_created
  ON in_routing_events (created_at desc, ttfb_ms);

CREATE TABLE IF NOT EXISTS in_request_log (
  id uuid PRIMARY KEY,
  request_id text NOT NULL,
  attempt_no integer NOT NULL DEFAULT 1,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_preview text,
  response_preview text,
  full_prompt_encrypted bytea,
  full_response_encrypted bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_request_log_attempt_no CHECK (attempt_no >= 1)
);

CREATE INDEX IF NOT EXISTS idx_in_request_log_org_created
  ON in_request_log (org_id, created_at desc);

CREATE UNIQUE INDEX IF NOT EXISTS idx_in_request_log_org_req_attempt
  ON in_request_log (org_id, request_id, attempt_no);

CREATE TABLE IF NOT EXISTS in_token_credential_events (
  id uuid PRIMARY KEY,
  token_credential_id uuid NOT NULL REFERENCES in_token_credentials(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  event_type text NOT NULL,
  status_code integer,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_token_credential_events_type
    CHECK (event_type in ('maxed', 'reactivated', 'probe_failed'))
);

CREATE INDEX IF NOT EXISTS idx_in_token_credential_events_credential_created
  ON in_token_credential_events (token_credential_id, created_at desc);

CREATE INDEX IF NOT EXISTS idx_in_token_credential_events_type_created
  ON in_token_credential_events (event_type, created_at desc);
