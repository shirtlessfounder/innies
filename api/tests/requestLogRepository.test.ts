import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RequestLogRepository } from '../src/repos/requestLogRepository.js';
import { encryptSecret } from '../src/utils/crypto.js';
import { MockSqlClient } from './testHelpers.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('RequestLogRepository', () => {
  const originalEncryptionKey = process.env.SELLER_SECRET_ENC_KEY_B64;

  beforeEach(() => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.SELLER_SECRET_ENC_KEY_B64;
      return;
    }
    process.env.SELLER_SECRET_ENC_KEY_B64 = originalEncryptionKey;
  });

  it('writes phase-1 archive metadata and returns the durable request-attempt id', async () => {
    const db = new MockSqlClient({
      rows: [{ id: '11111111-1111-4111-8111-111111111111' }],
      rowCount: 1
    });
    const repo = new RequestLogRepository(db, () => '22222222-2222-4222-8222-222222222222');

    const archiveId = await repo.insert({
      requestId: 'req_archive_1',
      attemptNo: 2,
      orgId: '33333333-3333-4333-8333-333333333333',
      provider: 'openai',
      model: 'gpt-5.4',
      proxiedPath: '/v1/responses',
      requestContentType: 'application/json',
      responseContentType: 'text/event-stream; charset=utf-8',
      promptPreview: 'hello archive',
      responsePreview: 'world archive',
      fullPrompt: '{"input":"hello archive"}',
      fullResponse: 'data: {"type":"response.completed"}'
    });

    expect(archiveId).toBe('11111111-1111-4111-8111-111111111111');
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].sql).toContain('proxied_path');
    expect(db.queries[0].sql).toContain('request_content_type');
    expect(db.queries[0].sql).toContain('response_content_type');
    expect(db.queries[0].sql).toContain('returning id');
    expect(db.queries[0].sql).toContain('on conflict (org_id, request_id, attempt_no)');
    expect(db.queries[0].params?.slice(0, 11)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      'req_archive_1',
      2,
      '33333333-3333-4333-8333-333333333333',
      'openai',
      'gpt-5.4',
      '/v1/responses',
      'application/json',
      'text/event-stream; charset=utf-8',
      'hello archive',
      'world archive'
    ]);
    expect(Buffer.isBuffer(db.queries[0].params?.[11])).toBe(true);
    expect(Buffer.isBuffer(db.queries[0].params?.[12])).toBe(true);
    expect(db.queries[1].sql).toContain('insert into in_live_lane_projection_outbox');
    expect(db.queries[1].sql).toContain('join in_routing_events');
    expect(db.queries[1].params?.slice(0, 3)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      'req_archive_1',
      2
    ]);
  });

  it('finds archive rows by durable id and decrypts the stored full bodies', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: '44444444-4444-4444-8444-444444444444',
        request_id: 'req_archive_2',
        attempt_no: 1,
        org_id: '55555555-5555-4555-8555-555555555555',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        proxied_path: '/v1/messages',
        request_content_type: 'application/json',
        response_content_type: 'application/json',
        prompt_preview: 'hello buyer',
        response_preview: 'hello assistant',
        full_prompt_encrypted: encryptSecret('{"messages":[{"role":"user","content":"hello buyer"}]}'),
        full_response_encrypted: encryptSecret('{"content":[{"type":"text","text":"hello assistant"}]}'),
        created_at: '2026-04-16T03:04:05.000Z'
      }],
      rowCount: 1
    });
    const repo = new RequestLogRepository(db);

    const row = await repo.findById('44444444-4444-4444-8444-444444444444', true);

    expect(row).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      requestId: 'req_archive_2',
      attemptNo: 1,
      orgId: '55555555-5555-4555-8555-555555555555',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      proxiedPath: '/v1/messages',
      requestContentType: 'application/json',
      responseContentType: 'application/json',
      promptPreview: 'hello buyer',
      responsePreview: 'hello assistant',
      fullPrompt: '{"messages":[{"role":"user","content":"hello buyer"}]}',
      fullResponse: '{"content":[{"type":"text","text":"hello assistant"}]}',
      createdAt: new Date('2026-04-16T03:04:05.000Z')
    });
    expect(db.queries[0].sql).toContain('where id = $1');
    expect(db.queries[0].params).toEqual(['44444444-4444-4444-8444-444444444444']);
  });
});
