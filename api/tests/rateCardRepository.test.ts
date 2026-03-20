import { describe, expect, it } from 'vitest';
import { RateCardRepository } from '../src/repos/rateCardRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('RateCardRepository', () => {
  it('writes version and line-item rows', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'rate_1', version_key: 'pilot-v1' }],
      rowCount: 1
    });
    const repo = new RateCardRepository(db, () => 'rate_1');

    await repo.createVersion({
      versionKey: 'pilot-v1',
      effectiveAt: new Date('2026-03-20T00:00:00.000Z')
    });

    expect(db.queries[0].sql).toContain('insert into in_rate_card_versions');
    expect(db.queries[0].params).toContain('pilot-v1');
  });

  it('resolves the active rate card with exact-model preference over wildcard', async () => {
    const db = new MockSqlClient({
      rows: [{
        rate_card_version_id: 'rate_1',
        version_key: 'pilot-v1',
        provider: 'anthropic',
        model_pattern: 'claude-opus-4-6',
        routing_mode: 'paid-team-capacity',
        buyer_debit_minor_per_unit: 3,
        contributor_earnings_minor_per_unit: 0,
        currency: 'USD'
      }],
      rowCount: 1
    });
    const repo = new RateCardRepository(db, () => 'line_1');

    const applied = await repo.resolveAppliedRate({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      routingMode: 'paid-team-capacity'
    });

    expect(applied).toEqual({
      rateCardVersionId: 'rate_1',
      versionKey: 'pilot-v1',
      provider: 'anthropic',
      modelPattern: 'claude-opus-4-6',
      routingMode: 'paid-team-capacity',
      buyerDebitMinorPerUnit: 3,
      contributorEarningsMinorPerUnit: 0,
      currency: 'USD'
    });
    expect(db.queries[0].sql).toContain('join in_rate_card_line_items');
    expect(db.queries[0].sql).toContain('model_pattern = $4 or i.model_pattern = \'*\'');
  });

  it('creates versions and line items in one transaction', async () => {
    const events: string[] = [];
    const db = new MockSqlClient({ rows: [{ id: 'rate_1' }], rowCount: 1 });
    db.transaction = async (run) => {
      events.push('begin');
      const result = await run({
        query: async (sql, params) => {
          events.push(sql.includes('in_rate_card_versions') ? 'version' : 'line_item');
          return db.query(sql, params);
        }
      });
      events.push('commit');
      return result;
    };
    const repo = new RateCardRepository(db, () => 'rate_1');

    await repo.createVersionWithLineItems({
      versionKey: 'pilot-v1',
      effectiveAt: new Date('2026-03-20T00:00:00.000Z'),
      lineItems: [{
        provider: 'anthropic',
        modelPattern: '*',
        routingMode: 'paid-team-capacity',
        buyerDebitMinorPerUnit: 3,
        contributorEarningsMinorPerUnit: 0,
        currency: 'USD'
      }]
    });

    expect(events).toEqual(['begin', 'version', 'line_item', 'commit']);
  });
});
