import { describe, expect, it } from 'vitest';
import { CanonicalMeteringRepository } from '../src/repos/canonicalMeteringRepository.js';
import { MeteringProjectorStateRepository } from '../src/repos/meteringProjectorStateRepository.js';
import { RateCardRepository } from '../src/repos/rateCardRepository.js';
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
    const writer = new UsageMeteringWriter({ usageLedgerRepo: repo });

    await writer.recordUsage(sampleEvent);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_usage_ledger');
    expect(db.queries[0].params?.[1]).toBe('usage');
  });

  it('writes correction and reversal rows with source_event_id', async () => {
    const db = new MockSqlClient({ rows: [{ id: 'usage_2' }], rowCount: 1 });
    const repo = new UsageLedgerRepository(db);
    const writer = new UsageMeteringWriter({ usageLedgerRepo: repo });

    await writer.recordCorrection('orig_1', sampleEvent, 'meter correction');
    await writer.recordReversal('orig_1', sampleEvent, 'full reversal');

    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].params?.[1]).toBe('correction');
    expect(db.queries[0].params?.[14]).toBe('orig_1');
    expect(db.queries[1].params?.[1]).toBe('reversal');
    expect(db.queries[1].params?.[14]).toBe('orig_1');
  });

  it('dual-writes canonical metering when routing mode and rate card are known', async () => {
    const usageDb = new MockSqlClient({ rows: [{ id: 'usage_3', entry_type: 'usage' }], rowCount: 1 });
    const canonicalDb = new MockSqlClient({ rows: [{ id: 'meter_1' }], rowCount: 1 });
    const projectorDb = new MockSqlClient({ rows: [{ metering_event_id: 'meter_1', projector: 'wallet' }], rowCount: 1 });
    const writer = new UsageMeteringWriter({
      usageLedgerRepo: new UsageLedgerRepository(usageDb),
      canonicalMeteringRepo: new CanonicalMeteringRepository(canonicalDb, () => 'meter_1'),
      meteringProjectorStateRepo: new MeteringProjectorStateRepository(projectorDb),
      rateCardRepo: {
        resolveAppliedRate: async () => ({
          rateCardVersionId: 'rate_1',
          versionKey: 'pilot-v1',
          provider: 'anthropic',
          modelPattern: 'claude-sonnet',
          routingMode: 'paid-team-capacity',
          buyerDebitMinorPerUnit: 2,
          contributorEarningsMinorPerUnit: 0,
          currency: 'USD'
        })
      } as unknown as RateCardRepository
    });

    await writer.recordUsage({
      ...sampleEvent,
      admissionRoutingMode: 'paid-team-capacity'
    });

    expect(canonicalDb.queries).toHaveLength(1);
    expect(canonicalDb.queries[0].sql).toContain('insert into in_canonical_metering_events');
    expect(canonicalDb.queries[0].params).toContain('paid-team-capacity');
    expect(canonicalDb.queries[0].params).toContain('rate_1');
    expect(projectorDb.queries).toHaveLength(1);
    expect(projectorDb.queries[0].params).toContain('wallet');
  });
});
