BEGIN;

CREATE TABLE IF NOT EXISTS in_request_attempt_archives (
  id uuid PRIMARY KEY,
  request_id text NOT NULL,
  attempt_no integer NOT NULL,
  org_id uuid NOT NULL,
  api_key_id uuid,
  route_kind text NOT NULL,
  seller_key_id uuid,
  token_credential_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  streaming boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  upstream_status integer,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  openclaw_run_id text,
  openclaw_session_id text,
  routing_event_id uuid,
  usage_ledger_id uuid,
  metering_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_request_attempt_archives_attempt_no CHECK (attempt_no >= 1),
  CONSTRAINT chk_in_request_attempt_archives_route_kind CHECK (route_kind IN ('seller_key', 'token_credential')),
  CONSTRAINT chk_in_request_attempt_archives_status CHECK (status IN ('success', 'failed', 'partial')),
  UNIQUE (org_id, request_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_in_request_attempt_archives_org_created
  ON in_request_attempt_archives (org_id, created_at desc);

CREATE INDEX IF NOT EXISTS idx_in_request_attempt_archives_request_attempt
  ON in_request_attempt_archives (request_id, attempt_no);

CREATE TABLE IF NOT EXISTS in_message_blobs (
  id uuid PRIMARY KEY,
  content_hash text NOT NULL,
  kind text NOT NULL,
  role text,
  content_type text NOT NULL,
  normalized_payload jsonb NOT NULL,
  normalized_payload_codec_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_message_blobs_kind CHECK (kind IN ('message', 'part'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_message_blobs_content_hash
  ON in_message_blobs (content_hash);

CREATE TABLE IF NOT EXISTS in_request_attempt_messages (
  request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE,
  side text NOT NULL,
  ordinal integer NOT NULL,
  message_blob_id uuid NOT NULL REFERENCES in_message_blobs(id) ON DELETE RESTRICT,
  role text,
  content_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_request_attempt_messages_side CHECK (side IN ('request', 'response')),
  CONSTRAINT chk_in_request_attempt_messages_ordinal CHECK (ordinal >= 0),
  PRIMARY KEY (request_attempt_archive_id, side, ordinal)
);

CREATE TABLE IF NOT EXISTS in_raw_blobs (
  id uuid PRIMARY KEY,
  content_hash text NOT NULL,
  blob_kind text NOT NULL,
  encoding text NOT NULL,
  bytes_compressed integer NOT NULL,
  bytes_uncompressed integer NOT NULL,
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_raw_blobs_blob_kind CHECK (blob_kind IN ('raw_request', 'raw_response', 'raw_stream')),
  CONSTRAINT chk_in_raw_blobs_encoding CHECK (encoding IN ('gzip', 'none')),
  CONSTRAINT chk_in_raw_blobs_bytes CHECK (bytes_compressed >= 0 AND bytes_uncompressed >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_in_raw_blobs_content_hash_kind
  ON in_raw_blobs (content_hash, blob_kind);

CREATE TABLE IF NOT EXISTS in_request_attempt_raw_blobs (
  request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE,
  blob_role text NOT NULL,
  raw_blob_id uuid NOT NULL REFERENCES in_raw_blobs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_in_request_attempt_raw_blobs_role CHECK (blob_role IN ('request', 'response', 'stream')),
  PRIMARY KEY (request_attempt_archive_id, blob_role)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT ALL PRIVILEGES ON TABLE in_request_attempt_archives TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_message_blobs TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_request_attempt_messages TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_raw_blobs TO niyant;
    GRANT ALL PRIVILEGES ON TABLE in_request_attempt_raw_blobs TO niyant;
  END IF;
END $$;

COMMIT;
