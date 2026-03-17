CREATE TABLE IF NOT EXISTS in_token_affinity_assignments (
  org_id uuid NOT NULL,
  provider text NOT NULL,
  credential_id uuid NOT NULL,
  session_id text NOT NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  grace_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider, credential_id),
  UNIQUE (org_id, provider, session_id)
);

CREATE TABLE IF NOT EXISTS in_token_affinity_active_streams (
  request_id text PRIMARY KEY,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  credential_id uuid NOT NULL,
  session_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_touched_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_in_token_affinity_assignments_session
  ON in_token_affinity_assignments (org_id, provider, session_id);

CREATE INDEX IF NOT EXISTS idx_in_token_affinity_assignments_grace
  ON in_token_affinity_assignments (org_id, provider, grace_expires_at);

CREATE INDEX IF NOT EXISTS idx_in_token_affinity_active_streams_partition
  ON in_token_affinity_active_streams (org_id, provider, credential_id);

CREATE INDEX IF NOT EXISTS idx_in_token_affinity_active_streams_stale
  ON in_token_affinity_active_streams (last_touched_at)
  WHERE ended_at IS NULL;
