import { describe, expect, it } from 'vitest';
import { CanonicalMeteringRepository } from '../src/repos/canonicalMeteringRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const sampleServedRequest = {
  requestId: 'req_1',
  attemptNo: 2,
  sessionId: 'sess_1',
  admissionOrgId: 'org_fnf',
  admissionCutoverId: 'cut_1',
  admissionRoutingMode: 'paid-team-capacity' as const,
  consumerOrgId: 'org_fnf',
  consumerUserId: 'user_darryn',
  teamConsumerId: null,
  buyerKeyId: 'buyer_1',
  servingOrgId: 'org_innies',
  providerAccountId: 'provider_acct_1',
  tokenCredentialId: 'cred_1',
  capacityOwnerUserId: null,
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  rateCardVersionId: 'rate_1',
  inputTokens: 111,
  outputTokens: 222,
  usageUnits: 333,
  buyerDebitMinor: 444,
  contributorEarningsMinor: 0,
  currency: 'USD',
  metadata: { source: 'test' }
};

describe('CanonicalMeteringRepository', () => {
  it('writes served_request rows with the locked financial-finalization fields', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'meter_1', finalization_kind: 'served_request' }],
      rowCount: 1
    });
    const repo = new CanonicalMeteringRepository(db, () => 'meter_1');

    const row = await repo.createServedRequest(sampleServedRequest);

    expect(row.id).toBe('meter_1');
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_canonical_metering_events');
    expect(db.queries[0].sql).toContain('on conflict (request_id, attempt_no, finalization_kind)');
    expect(db.queries[0].params).toContain('served_request');
    expect(db.queries[0].params).toContain('req_1:2:served_request');
    expect(db.queries[0].params).toContain('paid-team-capacity');
    expect(db.queries[0].params).toContain('rate_1');
    expect(db.queries[0].params).toContain('org_innies');
    expect(db.queries[0].params).toContain(444);
  });

  it('requires source metering ids for correction rows', async () => {
    const db = new MockSqlClient();
    const repo = new CanonicalMeteringRepository(db, () => 'meter_2');

    await expect(repo.insertEvent({
      ...sampleServedRequest,
      finalizationKind: 'correction',
      buyerDebitMinor: -30
    })).rejects.toThrow('correction rows require sourceMeteringEventId');
  });

  it('rejects source metering ids on served_request rows', async () => {
    const db = new MockSqlClient();
    const repo = new CanonicalMeteringRepository(db, () => 'meter_3');

    await expect(repo.insertEvent({
      ...sampleServedRequest,
      finalizationKind: 'served_request',
      sourceMeteringEventId: 'meter_orig'
    })).rejects.toThrow('served_request rows cannot set sourceMeteringEventId');
  });

  it('rejects idempotent replay when the stored canonical row drifts from the payload', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'meter_existing',
          request_id: 'req_1',
          attempt_no: 2,
          finalization_kind: 'served_request',
          idempotency_key: 'req_1:2:served_request',
          session_id: 'sess_1',
          source_metering_event_id: null,
          admission_org_id: 'org_fnf',
          admission_cutover_id: 'cut_1',
          admission_routing_mode: 'paid-team-capacity',
          consumer_org_id: 'org_fnf',
          consumer_user_id: 'user_darryn',
          team_consumer_id: null,
          buyer_key_id: 'buyer_1',
          serving_org_id: 'org_innies',
          provider_account_id: 'provider_acct_1',
          token_credential_id: 'cred_1',
          capacity_owner_user_id: null,
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          rate_card_version_id: 'rate_1',
          input_tokens: 111,
          output_tokens: 222,
          usage_units: 333,
          buyer_debit_minor: 999,
          contributor_earnings_minor: 0,
          currency: 'USD',
          metadata: { source: 'test' },
          created_at: '2026-03-20T03:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new CanonicalMeteringRepository(db, () => 'meter_new');

    await expect(repo.createServedRequest(sampleServedRequest)).rejects.toThrow(
      'canonical metering idempotent replay mismatch'
    );
  });
});
