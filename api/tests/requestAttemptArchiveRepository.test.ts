import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestAttemptArchiveRepository } from '../src/repos/requestAttemptArchiveRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive_no_extensions.sql');

const sampleAttempt = {
  requestId: 'req_1',
  attemptNo: 2,
  orgId: 'org_1',
  apiKeyId: 'api_key_1',
  routeKind: 'token_credential' as const,
  sellerKeyId: null,
  tokenCredentialId: 'cred_1',
  provider: 'anthropic',
  model: 'claude-opus-4-1',
  streaming: true,
  status: 'success' as const,
  upstreamStatus: 200,
  errorCode: null,
  startedAt: new Date('2026-03-26T03:00:00Z'),
  completedAt: new Date('2026-03-26T03:00:04Z'),
  openclawRunId: 'run_1',
  openclawSessionId: 'session_1',
  routingEventId: 'route_1',
  usageLedgerId: 'usage_1',
  meteringEventId: 'meter_1'
};

describe('RequestAttemptArchiveRepository', () => {
  it('upserts archived attempts by org, request, and attempt number', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'archive_1',
        request_id: 'req_1',
        attempt_no: 2,
        org_id: 'org_1',
        status: 'success'
      }],
      rowCount: 1
    });
    const repo = new RequestAttemptArchiveRepository(db, () => 'archive_1');

    const row = await repo.upsertArchive(sampleAttempt);

    expect(row).toEqual(expect.objectContaining({ id: 'archive_1', request_id: 'req_1' }));
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_request_attempt_archives');
    expect(db.queries[0].sql).toContain('on conflict (org_id, request_id, attempt_no)');
    expect(db.queries[0].sql).toContain('returning *');
    expect(db.queries[0].params).toContain('archive_1');
    expect(db.queries[0].params).toContain('req_1');
    expect(db.queries[0].params).toContain('token_credential');
    expect(db.queries[0].params).toContain('success');
    expect(db.queries[0].params).toContain(200);
  });

  it('rejects duplicate archive replays when canonical fields drift', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'archive_existing',
          request_id: 'req_1',
          attempt_no: 2,
          org_id: 'org_1',
          api_key_id: 'api_key_1',
          route_kind: 'token_credential',
          seller_key_id: null,
          token_credential_id: 'cred_1',
          provider: 'anthropic',
          model: 'claude-opus-4-1',
          streaming: true,
          status: 'failed',
          upstream_status: 200,
          error_code: null,
          started_at: '2026-03-26T03:00:00Z',
          completed_at: '2026-03-26T03:00:04Z',
          openclaw_run_id: 'run_1',
          openclaw_session_id: 'session_1',
          routing_event_id: 'route_1',
          usage_ledger_id: 'usage_1',
          metering_event_id: 'meter_1',
          created_at: '2026-03-26T03:00:05Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new RequestAttemptArchiveRepository(db, () => 'archive_new');

    await expect(repo.upsertArchive(sampleAttempt)).rejects.toThrow(
      'request attempt archive idempotent replay mismatch'
    );
  });

  it('defines attempt uniqueness and lookup indexes in both migration variants', () => {
    const candidates = [
      readFileSync(migrationPath, 'utf8'),
      readFileSync(noExtensionsMigrationPath, 'utf8')
    ];

    for (const sql of candidates) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_request_attempt_archives');
      expect(sql).toContain('UNIQUE (org_id, request_id, attempt_no)');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_request_attempt_archives_org_created');
      expect(sql).toContain('ON in_request_attempt_archives (org_id, created_at desc)');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_request_attempt_archives_request_attempt');
      expect(sql).toContain('ON in_request_attempt_archives (request_id, attempt_no)');
    }
  });
});
