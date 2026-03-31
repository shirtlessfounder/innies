import { describe, expect, it } from 'vitest';
import { RequestLogRepository } from '../src/repos/requestLogRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('RequestLogRepository', () => {
  it('finds one preview row by org, request id, and attempt number', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'log_1',
        request_id: 'req_1',
        attempt_no: 2,
        org_id: 'org_1',
        provider: 'anthropic',
        model: 'claude-opus-4-1',
        prompt_preview: 'hello',
        response_preview: 'world',
        full_prompt_encrypted: null,
        full_response_encrypted: null,
        created_at: '2026-03-31T22:00:00Z'
      }],
      rowCount: 1
    });
    const repo = new RequestLogRepository(db, () => 'log_1');

    const row = await repo.findByOrgRequestAttempt({
      orgId: 'org_1',
      requestId: 'req_1',
      attemptNo: 2
    });

    expect(row).toEqual(expect.objectContaining({
      requestId: 'req_1',
      attemptNo: 2,
      orgId: 'org_1',
      promptPreview: 'hello',
      responsePreview: 'world'
    }));
    expect(db.queries[0].sql).toContain('where org_id = $1');
    expect(db.queries[0].sql).toContain('and request_id = $2');
    expect(db.queries[0].sql).toContain('and attempt_no = $3');
  });

  it('returns null when the preview row is missing', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 }
    ]);
    const repo = new RequestLogRepository(db, () => 'log_1');

    await expect(repo.findByOrgRequestAttempt({
      orgId: 'org_1',
      requestId: 'missing',
      attemptNo: 1
    })).resolves.toBeNull();
  });
});
