import { describe, expect, it } from 'vitest';
import { MockSqlClient } from './testHelpers.js';
import { RoutingAttributionRepository } from '../src/repos/routingAttributionRepository.js';

describe('RoutingAttributionRepository', () => {
  it('filters org request history to post-cutover rows when requested', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_id: 'req_1',
        attempt_no: 1,
        session_id: 'sess_1',
        admission_org_id: 'org_fnf',
        admission_cutover_id: 'cut_1',
        admission_routing_mode: 'self-free',
        consumer_org_id: 'org_fnf',
        buyer_key_id: 'buyer_1',
        serving_org_id: 'org_fnf',
        provider_account_id: 'acct_1',
        token_credential_id: 'cred_1',
        capacity_owner_user_id: 'user_1',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        rate_card_version_id: 'rate_1',
        input_tokens: 10,
        output_tokens: 20,
        usage_units: 30,
        buyer_debit_minor: 0,
        contributor_earnings_minor: 0,
        currency: 'USD',
        metadata: { source: 'test' },
        created_at: '2026-03-20T10:00:00Z',
        prompt_preview: 'hello',
        response_preview: 'world',
        route_decision: { reason: 'preferred_provider_selected' },
        projector_states: []
      }],
      rowCount: 1
    });
    const repo = new RoutingAttributionRepository(db);

    const rows = await repo.listOrgRequestHistory({
      orgId: 'org_fnf',
      limit: 20,
      historyScope: 'post_cutover'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].admission_routing_mode).toBe('self-free');
    expect(db.queries[0].sql).toContain('cm.admission_cutover_id is not null');
    expect(db.queries[0].sql).toContain('left join in_routing_events');
  });

  it('applies cursor filtering using the full sort key', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new RoutingAttributionRepository(db);

    await repo.listOrgRequestHistory({
      orgId: 'org_fnf',
      limit: 20,
      historyScope: 'post_cutover',
      cursor: {
        createdAt: '2026-03-20T10:00:00Z',
        requestId: 'req_9',
        attemptNo: 3
      }
    });

    expect(db.queries[0].sql).toContain('cm.created_at < $2');
    expect(db.queries[0].sql).toContain('cm.created_at = $2 and cm.request_id < $3');
    expect(db.queries[0].sql).toContain('cm.request_id = $3 and cm.attempt_no < $4');
  });

  it('lists financially unfinalized requests by joining routing events to canonical metering', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_id: 'req_missing',
        attempt_no: 2,
        org_id: 'org_fnf',
        provider: 'openai',
        model: 'gpt-5-codex',
        upstream_status: 200,
        created_at: '2026-03-20T12:00:00Z',
        route_decision: { reason: 'cli_provider_pinned' }
      }],
      rowCount: 1
    });
    const repo = new RoutingAttributionRepository(db);

    const rows = await repo.listFinanciallyUnfinalizedRequests(10);

    expect(rows).toHaveLength(1);
    expect(rows[0].request_id).toBe('req_missing');
    expect(db.queries[0].sql).toContain('left join in_canonical_metering_events');
    expect(db.queries[0].sql).toContain('cm.id is null');
    expect(db.queries[0].sql).toContain('re.upstream_status < 300');
  });
});
