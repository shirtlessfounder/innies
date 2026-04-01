import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../src/repos/tableNames.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/027_admin_analysis_substrate.sql');
const noExtensionsMigrationPath = resolve(
  process.cwd(),
  '../docs/migrations/027_admin_analysis_substrate_no_extensions.sql'
);

describe('admin analysis substrate migrations', () => {
  it('pins the primary migration to the admin analysis projection schema', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expectProjectionContract(sql);
  });

  it('keeps the no-extensions migration aligned with the primary analysis contract', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expectProjectionContract(sql);
  });

  it('registers the admin analysis projection table names', () => {
    expect(TABLES.adminAnalysisProjectionOutbox).toBe('in_admin_analysis_request_projection_outbox');
    expect(TABLES.adminAnalysisRequests).toBe('in_admin_analysis_requests');
    expect(TABLES.adminAnalysisSessions).toBe('in_admin_analysis_sessions');
  });
});

function expectProjectionContract(sql: string): void {
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_admin_analysis_request_projection_outbox');
  expect(sql).toContain('request_attempt_archive_id uuid NOT NULL REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE');
  expect(sql).toContain("projection_state text NOT NULL DEFAULT 'pending_projection'");
  expect(sql).toContain("CHECK (projection_state IN ('pending_projection', 'projected', 'needs_operator_correction'))");
  expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_admin_analysis_projection_outbox_attempt');
  expect(sql).toContain('ON in_admin_analysis_request_projection_outbox (request_attempt_archive_id)');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_projection_outbox_due');

  expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_admin_analysis_requests');
  expect(sql).toContain('request_attempt_archive_id uuid PRIMARY KEY REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE');
  expect(sql).toContain('session_key text NOT NULL REFERENCES in_admin_sessions(session_key) ON DELETE CASCADE');
  expect(sql).toContain('task_category text NOT NULL');
  expect(sql).toContain('task_tags text[] NOT NULL DEFAULT \'{}\'');
  expect(sql).toContain('interestingness_score integer NOT NULL DEFAULT 0');
  expect(sql).toContain("CHECK (task_category IN ('debugging', 'feature_building', 'code_review', 'research', 'ops', 'writing', 'data_analysis', 'other'))");
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_window');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_requests_session');

  expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_admin_analysis_sessions');
  expect(sql).toContain('session_key text PRIMARY KEY REFERENCES in_admin_sessions(session_key) ON DELETE CASCADE');
  expect(sql).toContain('primary_task_category text NOT NULL');
  expect(sql).toContain("CHECK (primary_task_category IN ('debugging', 'feature_building', 'code_review', 'research', 'ops', 'writing', 'data_analysis', 'other'))");
  expect(sql).toContain('task_category_breakdown jsonb NOT NULL DEFAULT \'{}\'::jsonb');
  expect(sql).toContain('task_tag_set text[] NOT NULL DEFAULT \'{}\'');
  expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_admin_analysis_sessions_last_activity');

  expect(sql).toContain('FROM pg_roles');
  expect(sql).toContain("WHERE rolname = 'niyant'");
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_admin_analysis_request_projection_outbox TO niyant');
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_admin_analysis_requests TO niyant');
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_admin_analysis_sessions TO niyant');
}
