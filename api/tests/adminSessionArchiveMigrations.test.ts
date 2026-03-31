import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../src/repos/tableNames.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/026_admin_session_archive_projection.sql');
const noExtensionsMigrationPath = resolve(
  process.cwd(),
  '../docs/migrations/026_admin_session_archive_projection_no_extensions.sql'
);

describe('admin session archive projection migrations', () => {
  it('pins the primary migration to the admin session projection schema', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expectProjectionContract(sql);
  });

  it('keeps the no-extensions migration aligned with the primary projection contract', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expectProjectionContract(sql);
  });

  it('registers the admin session projection table names', () => {
    expect(TABLES.adminSessionProjectionOutbox).toBe('in_admin_session_projection_outbox');
    expect(TABLES.adminSessions).toBe('in_admin_sessions');
    expect(TABLES.adminSessionAttempts).toBe('in_admin_session_attempts');
  });
});

function expectProjectionContract(sql: string): void {
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_admin_session_projection_outbox');
  expect(sql).toContain('request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE');
  expect(sql).toContain("projection_state text NOT NULL DEFAULT 'pending_projection'");
  expect(sql).toContain("CHECK (projection_state IN ('pending_projection', 'projected', 'needs_operator_correction'))");
  expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_admin_session_projection_outbox_attempt');
  expect(sql).toContain('ON in_admin_session_projection_outbox (request_attempt_archive_id)');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_session_projection_outbox_due');

  expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_admin_sessions');
  expect(sql).toContain('session_key text PRIMARY KEY');
  expect(sql).toContain("CHECK (session_type IN ('cli', 'openclaw'))");
  expect(sql).toContain("CHECK (grouping_basis IN ('explicit_session_id', 'explicit_run_id', 'idle_gap', 'request_fallback'))");
  expect(sql).toContain('preview_sample jsonb');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_sessions_org_last_activity');

  expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_admin_session_attempts');
  expect(sql).toContain('session_key text NOT NULL REFERENCES in_admin_sessions(session_key) ON DELETE CASCADE');
  expect(sql).toContain('request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE');
  expect(sql).toContain('sequence_no integer NOT NULL');
  expect(sql).toContain('UNIQUE (session_key, request_attempt_archive_id)');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_session_attempts_session_event');
  expect(sql).toContain('ON in_admin_session_attempts (session_key, event_time, request_id, attempt_no, sequence_no)');

  expect(sql).toContain('FROM pg_roles');
  expect(sql).toContain("WHERE rolname = 'niyant'");
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_admin_session_projection_outbox TO niyant');
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_admin_sessions TO niyant');
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_admin_session_attempts TO niyant');
}
