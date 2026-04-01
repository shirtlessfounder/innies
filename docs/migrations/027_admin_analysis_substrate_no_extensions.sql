BEGIN;

CREATE TABLE IF NOT EXISTS in_admin_analysis_request_projection_outbox (
  id uuid PRIMARY KEY,
  request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  org_id uuid NOT NULL,
  api_key_id uuid,
  projection_state text NOT NULL DEFAULT 'pending_projection',
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz DEFAULT now(),
  last_attempted_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_admin_analysis_projection_outbox_attempt_no CHECK (attempt_no >= 1),
  CONSTRAINT chk_in_admin_analysis_projection_outbox_retry_count CHECK (retry_count >= 0),
  CONSTRAINT chk_in_admin_analysis_projection_outbox_state
    CHECK (projection_state IN ('pending_projection', 'projected', 'needs_operator_correction'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_admin_analysis_projection_outbox_attempt
  ON in_admin_analysis_request_projection_outbox (request_attempt_archive_id);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_projection_outbox_due
  ON in_admin_analysis_request_projection_outbox (projection_state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS in_admin_analysis_requests (
  request_attempt_archive_id uuid PRIMARY KEY REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  session_key text NOT NULL REFERENCES in_admin_sessions(session_key) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  api_key_id uuid,
  session_type text NOT NULL,
  grouping_basis text NOT NULL,
  source text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  user_message_preview text,
  assistant_text_preview text,
  task_category text NOT NULL,
  task_tags text[] NOT NULL DEFAULT '{}',
  is_retry boolean NOT NULL DEFAULT false,
  is_failure boolean NOT NULL DEFAULT false,
  is_partial boolean NOT NULL DEFAULT false,
  is_high_token boolean NOT NULL DEFAULT false,
  is_cross_provider_rescue boolean NOT NULL DEFAULT false,
  has_tool_use boolean NOT NULL DEFAULT false,
  interestingness_score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_admin_analysis_requests_attempt_no CHECK (attempt_no >= 1),
  CONSTRAINT chk_in_admin_analysis_requests_session_type CHECK (session_type IN ('cli', 'openclaw')),
  CONSTRAINT chk_in_admin_analysis_requests_grouping_basis
    CHECK (grouping_basis IN ('explicit_session_id', 'explicit_run_id', 'idle_gap', 'request_fallback')),
  CONSTRAINT chk_in_admin_analysis_requests_status CHECK (status IN ('success', 'failed', 'partial')),
  CONSTRAINT chk_in_admin_analysis_requests_task_category
    CHECK (task_category IN ('debugging', 'feature_building', 'code_review', 'research', 'ops', 'writing', 'data_analysis', 'other')),
  CONSTRAINT chk_in_admin_analysis_requests_tokens CHECK (input_tokens >= 0 AND output_tokens >= 0)
);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_window
  ON in_admin_analysis_requests (started_at desc, request_attempt_archive_id);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_dimensions
  ON in_admin_analysis_requests (org_id, session_type, provider, source, started_at desc);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_task_category
  ON in_admin_analysis_requests (task_category, started_at desc);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_session
  ON in_admin_analysis_requests (session_key, started_at asc, request_id asc, attempt_no asc);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_request_attempt
  ON in_admin_analysis_requests (request_id, attempt_no);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_task_tags
  ON in_admin_analysis_requests USING gin (task_tags);

CREATE TABLE IF NOT EXISTS in_admin_analysis_sessions (
  session_key text PRIMARY KEY REFERENCES in_admin_sessions(session_key) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  session_type text NOT NULL,
  grouping_basis text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  primary_task_category text NOT NULL,
  task_category_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_tag_set text[] NOT NULL DEFAULT '{}',
  is_long_session boolean NOT NULL DEFAULT false,
  is_high_token_session boolean NOT NULL DEFAULT false,
  is_retry_heavy_session boolean NOT NULL DEFAULT false,
  is_cross_provider_session boolean NOT NULL DEFAULT false,
  is_multi_model_session boolean NOT NULL DEFAULT false,
  interestingness_score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_admin_analysis_sessions_session_type CHECK (session_type IN ('cli', 'openclaw')),
  CONSTRAINT chk_in_admin_analysis_sessions_grouping_basis
    CHECK (grouping_basis IN ('explicit_session_id', 'explicit_run_id', 'idle_gap', 'request_fallback')),
  CONSTRAINT chk_in_admin_analysis_sessions_counts CHECK (request_count >= 0 AND attempt_count >= 0),
  CONSTRAINT chk_in_admin_analysis_sessions_tokens CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT chk_in_admin_analysis_sessions_primary_task_category
    CHECK (primary_task_category IN ('debugging', 'feature_building', 'code_review', 'research', 'ops', 'writing', 'data_analysis', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_sessions_last_activity
  ON in_admin_analysis_sessions (last_activity_at desc, session_key desc);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_sessions_org_type
  ON in_admin_analysis_sessions (org_id, session_type, last_activity_at desc, session_key desc);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_sessions_primary_task_category
  ON in_admin_analysis_sessions (primary_task_category, last_activity_at desc);

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_sessions_task_tag_set
  ON in_admin_analysis_sessions USING gin (task_tag_set);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT ALL PRIVILEGES ON TABLE in_admin_analysis_request_projection_outbox TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_admin_analysis_requests TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_admin_analysis_sessions TO niyant;
  END IF;
END $$;

COMMIT;
