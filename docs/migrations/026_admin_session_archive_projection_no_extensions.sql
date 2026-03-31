BEGIN;

CREATE TABLE IF NOT EXISTS in_admin_session_projection_outbox (
  id uuid PRIMARY KEY,
  request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  org_id uuid NOT NULL,
  api_key_id uuid,
  projection_state text NOT NULL DEFAULT 'pending_projection',
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_admin_session_projection_outbox_attempt_no CHECK (attempt_no >= 1),
  CONSTRAINT chk_in_admin_session_projection_outbox_retry_count CHECK (retry_count >= 0),
  CONSTRAINT chk_in_admin_session_projection_outbox_state
    CHECK (projection_state IN ('pending_projection', 'projected', 'needs_operator_correction'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_admin_session_projection_outbox_attempt
  ON in_admin_session_projection_outbox (request_attempt_archive_id);

CREATE INDEX IF NOT EXISTS idx_in_admin_session_projection_outbox_due
  ON in_admin_session_projection_outbox (projection_state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS in_admin_sessions (
  session_key text PRIMARY KEY,
  session_type text NOT NULL,
  grouping_basis text NOT NULL,
  org_id uuid NOT NULL,
  api_key_id uuid,
  source_session_id text,
  source_run_id text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  provider_set text[] NOT NULL DEFAULT '{}',
  model_set text[] NOT NULL DEFAULT '{}',
  status_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview_sample jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_admin_sessions_session_type CHECK (session_type IN ('cli', 'openclaw')),
  CONSTRAINT chk_in_admin_sessions_grouping_basis
    CHECK (grouping_basis IN ('explicit_session_id', 'explicit_run_id', 'idle_gap', 'request_fallback')),
  CONSTRAINT chk_in_admin_sessions_counts CHECK (request_count >= 0 AND attempt_count >= 0),
  CONSTRAINT chk_in_admin_sessions_tokens CHECK (input_tokens >= 0 AND output_tokens >= 0)
);

CREATE INDEX IF NOT EXISTS idx_in_admin_sessions_org_last_activity
  ON in_admin_sessions (org_id, last_activity_at desc, session_key desc);

CREATE INDEX IF NOT EXISTS idx_in_admin_sessions_lane_last_activity
  ON in_admin_sessions (org_id, api_key_id, session_type, last_activity_at desc, session_key desc);

CREATE TABLE IF NOT EXISTS in_admin_session_attempts (
  session_key text NOT NULL REFERENCES in_admin_sessions(session_key) ON DELETE CASCADE,
  request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  event_time timestamptz NOT NULL,
  sequence_no integer NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  streaming boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_admin_session_attempts_attempt_no CHECK (attempt_no >= 1),
  CONSTRAINT chk_in_admin_session_attempts_sequence_no CHECK (sequence_no >= 0),
  CONSTRAINT chk_in_admin_session_attempts_status CHECK (status IN ('success', 'failed', 'partial')),
  UNIQUE (session_key, request_attempt_archive_id)
);

CREATE INDEX IF NOT EXISTS idx_in_admin_session_attempts_session_event
  ON in_admin_session_attempts (session_key, event_time, request_id, attempt_no, sequence_no);

CREATE INDEX IF NOT EXISTS idx_in_admin_session_attempts_request_attempt
  ON in_admin_session_attempts (request_id, attempt_no);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT ALL PRIVILEGES ON TABLE in_admin_session_projection_outbox TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_admin_sessions TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_admin_session_attempts TO niyant;
  END IF;
END $$;

COMMIT;
