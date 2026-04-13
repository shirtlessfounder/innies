import { describe, expect, it } from 'vitest';
import { UsageLedgerRepository } from '../src/repos/usageLedgerRepository.js';
import { SequenceSqlClient } from './testHelpers.js';

describe('UsageLedgerRepository', () => {
  it('returns the existing usage row on idempotent replay', async () => {
    const existingRow = {
      id: 'usage_existing',
      entry_type: 'usage' as const,
      request_id: 'req_1',
      attempt_no: 1,
      org_id: 'org_1',
      api_key_id: 'api_1',
      seller_key_id: 'seller_1',
      provider: 'openai',
      model: 'gpt-5.4',
      input_tokens: 12,
      output_tokens: 34,
      usage_units: 46,
      retail_equivalent_minor: 46,
      currency: 'USD',
      source_event_id: null,
      note: 'metering_source=stream_usage',
      created_at: '2026-04-13T00:00:00.000Z'
    };
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [existingRow], rowCount: 1 }
    ]);
    const repo = new UsageLedgerRepository(db, () => 'usage_new');

    const row = await repo.createUsageRow({
      requestId: 'req_1',
      attemptNo: 1,
      orgId: 'org_1',
      apiKeyId: 'api_1',
      sellerKeyId: 'seller_1',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 12,
      outputTokens: 34,
      usageUnits: 46,
      retailEquivalentMinor: 46,
      currency: 'USD',
      note: 'metering_source=stream_usage'
    });

    expect(row).toEqual(existingRow);
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].sql).toContain('insert into in_usage_ledger');
    expect(db.queries[1].sql).toContain('from in_usage_ledger');
  });
});
