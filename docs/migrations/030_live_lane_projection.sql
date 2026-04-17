-- =========================================================
-- Canonical live-lane projection foundation
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS in_live_lanes (
  lane_id text PRIMARY KEY,
  session_key text NOT NULL,
  lane_source_kind text NOT NULL,
  lane_source_id text NOT NULL,
  buyer_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL,
  latest_request_id text,
  latest_attempt_no integer,
  latest_request_attempt_archive_id uuid,
  latest_provider text,
  latest_model text,
  first_event_at timestamptz,
  last_event_at timestamptz,
  projection_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_live_lanes_source_kind
    CHECK (lane_source_kind IN ('openclaw_session', 'request')),
  CONSTRAINT chk_in_live_lanes_latest_attempt_no
    CHECK (latest_attempt_no IS NULL OR latest_attempt_no > 0),
  CONSTRAINT uq_in_live_lanes_source
    UNIQUE (lane_source_kind, lane_source_id),
  CONSTRAINT uq_in_live_lanes_session_key
    UNIQUE (session_key)
);

CREATE TABLE IF NOT EXISTS in_live_lane_attempts (
  request_attempt_archive_id uuid PRIMARY KEY,
  lane_id text NOT NULL REFERENCES in_live_lanes(lane_id) ON DELETE CASCADE,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  buyer_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL,
  provider text,
  model text,
  request_source text,
  event_time timestamptz,
  projection_version integer NOT NULL DEFAULT 1,
  projected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_live_lane_attempts_attempt_no
    CHECK (attempt_no > 0),
  CONSTRAINT uq_in_live_lane_attempts_lane_request_attempt
    UNIQUE (lane_id, request_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS in_live_lane_events (
  lane_event_id text PRIMARY KEY,
  lane_id text NOT NULL REFERENCES in_live_lanes(lane_id) ON DELETE CASCADE,
  request_attempt_archive_id uuid NOT NULL REFERENCES in_live_lane_attempts(request_attempt_archive_id) ON DELETE CASCADE,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  side text NOT NULL,
  ordinal integer,
  event_kind text NOT NULL,
  event_time timestamptz NOT NULL,
  role text,
  provider text,
  model text,
  status text,
  render_text text,
  render_summary text,
  render_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  projection_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_live_lane_events_attempt_no
    CHECK (attempt_no > 0),
  CONSTRAINT chk_in_live_lane_events_side
    CHECK (side IN ('attempt', 'request', 'response', 'system')),
  CONSTRAINT chk_in_live_lane_events_ordinal
    CHECK (ordinal IS NULL OR ordinal > 0)
);

CREATE TABLE IF NOT EXISTS in_live_lane_projection_outbox (
  request_attempt_archive_id uuid PRIMARY KEY,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  state text NOT NULL DEFAULT 'pending_projection',
  retry_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  projected_at timestamptz,
  last_error_code text,
  last_error_message text,
  projection_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_live_lane_projection_outbox_attempt_no
    CHECK (attempt_no > 0),
  CONSTRAINT chk_in_live_lane_projection_outbox_retry_count
    CHECK (retry_count >= 0),
  CONSTRAINT chk_in_live_lane_projection_outbox_state
    CHECK (state IN ('pending_projection', 'projected', 'needs_operator_correction'))
);

CREATE INDEX IF NOT EXISTS idx_in_live_lanes_buyer_key_last_event
  ON in_live_lanes (buyer_api_key_id, last_event_at DESC, lane_id);

CREATE INDEX IF NOT EXISTS idx_in_live_lane_attempts_lane_event_time
  ON in_live_lane_attempts (lane_id, event_time DESC, request_attempt_archive_id);

CREATE INDEX IF NOT EXISTS idx_in_live_lane_events_lane_event_time
  ON in_live_lane_events (lane_id, event_time ASC, lane_event_id ASC);

CREATE INDEX IF NOT EXISTS idx_in_live_lane_events_attempt_event_time
  ON in_live_lane_events (request_attempt_archive_id, event_time ASC, lane_event_id ASC);

CREATE INDEX IF NOT EXISTS idx_in_live_lane_projection_outbox_due
  ON in_live_lane_projection_outbox (state, available_at ASC, request_attempt_archive_id ASC);

CREATE INDEX IF NOT EXISTS idx_in_live_lane_projection_outbox_retry_due
  ON in_live_lane_projection_outbox (state, next_retry_at ASC, request_attempt_archive_id ASC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT ALL PRIVILEGES ON TABLE in_live_lanes TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_live_lane_attempts TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_live_lane_events TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_live_lane_projection_outbox TO niyant;
  END IF;
END $$;

COMMIT;
