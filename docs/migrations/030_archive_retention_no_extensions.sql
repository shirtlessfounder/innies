BEGIN;

-- Retention support for prompt-archive storage introduced in migration 024.
-- Adds a pure-time index used by the archive retention job to purge rows
-- older than REQUEST_ARCHIVE_RETENTION_DAYS efficiently. The existing
-- (org_id, created_at desc) index is not used when scanning globally by
-- time alone.
CREATE INDEX IF NOT EXISTS idx_in_request_attempt_archives_created_at
  ON in_request_attempt_archives (created_at);

-- Projection outboxes accumulate rows with projection_state='projected'
-- indefinitely. Add indexes on processed_at so the retention job can
-- purge projected rows older than N days without sequential scans.
CREATE INDEX IF NOT EXISTS idx_in_admin_session_projection_outbox_processed_at
  ON in_admin_session_projection_outbox (processed_at)
  WHERE projection_state = 'projected';

CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_request_projection_outbox_processed_at
  ON in_admin_analysis_request_projection_outbox (processed_at)
  WHERE projection_state = 'projected';

-- No niyant grant changes: migration adds indexes on existing tables only;
-- the underlying tables already have niyant grants from migrations 024, 026,
-- and 027. Indexes inherit table permissions.

COMMIT;
