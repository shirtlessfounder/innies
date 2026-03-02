import { describe, expect, it } from 'vitest';
import { UsageLedgerRepository } from '../src/repos/usageLedgerRepository.js';
import { UsageMeteringWriter } from '../src/services/metering/usageMeteringWriter.js';
import { MockSqlClient } from './testHelpers.js';

const sampleEvent = {
  requestId: 'req_1',
  attemptNo: 1,
  orgId: 'org_1',
  apiKeyId: 'api_1',
  sellerKeyId: 'seller_1',
  provider: 'anthropic',
  model: 'claude-sonnet',
  inputTokens: 100,
  outputTokens: 250,
  usageUnits: 350,
  retailEquivalentMinor: 420
};

describe('UsageMeteringWriter', () => {
  it('writes primary usage rows', async () => {
    const db = new MockSqlClient({ rows: [{ id: 'usage_1' }], rowCount: 1 });
    const repo = new UsageLedgerRepository(db);
    const writer = new UsageMeteringWriter(repo);

    await writer.recordUsage(sampleEvent);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into hr_usage_ledger');
    expect(db.queries[0].params?.[1]).toBe('usage');
  });

  it('writes correction and reversal rows with source_event_id', async () => {
    const db = new MockSqlClient({ rows: [{ id: 'usage_2' }], rowCount: 1 });
    const repo = new UsageLedgerRepository(db);
    const writer = new UsageMeteringWriter(repo);

    await writer.recordCorrection('orig_1', sampleEvent, 'meter correction');
    await writer.recordReversal('orig_1', sampleEvent, 'full reversal');

    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].params?.[1]).toBe('correction');
    expect(db.queries[0].params?.[14]).toBe('orig_1');
    expect(db.queries[1].params?.[1]).toBe('reversal');
    expect(db.queries[1].params?.[14]).toBe('orig_1');
  });
});
