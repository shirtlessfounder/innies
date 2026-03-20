import { describe, expect, it, vi } from 'vitest';
import { EarningsProjectorService } from '../src/services/earnings/earningsProjectorService.js';

describe('EarningsProjectorService', () => {
  it('projects team-overflow accruals into withdrawable earnings and marks the projector projected', async () => {
    const findById = vi.fn().mockResolvedValue({
      id: 'meter_1',
      request_id: 'req_1',
      attempt_no: 1,
      finalization_kind: 'served_request',
      idempotency_key: 'req_1:1:served_request',
      session_id: null,
      source_metering_event_id: null,
      admission_org_id: 'org_innies',
      admission_cutover_id: 'cut_1',
      admission_routing_mode: 'team-overflow-on-contributor-capacity',
      consumer_org_id: 'org_innies',
      consumer_user_id: null,
      team_consumer_id: 'innies-team',
      buyer_key_id: null,
      serving_org_id: 'org_fnf',
      provider_account_id: 'acct_1',
      token_credential_id: 'cred_1',
      capacity_owner_user_id: 'user_darryn',
      provider: 'anthropic',
      model: 'claude-sonnet',
      rate_card_version_id: 'rate_1',
      input_tokens: 100,
      output_tokens: 200,
      usage_units: 300,
      buyer_debit_minor: 0,
      contributor_earnings_minor: 780,
      currency: 'USD',
      metadata: null,
      created_at: '2026-03-20T12:00:00Z'
    });
    const appendEntry = vi.fn().mockResolvedValue({ id: 'earn_1' });
    const listByMeteringEventId = vi.fn().mockResolvedValue([{
      metering_event_id: 'meter_1',
      projector: 'earnings',
      state: 'pending_projection',
      retry_count: 0,
      last_attempt_at: null,
      next_retry_at: null,
      last_error_code: null,
      last_error_message: null,
      projected_at: null,
      created_at: '2026-03-20T12:00:00Z',
      updated_at: '2026-03-20T12:00:00Z'
    }]);
    const markProjected = vi.fn().mockResolvedValue({});

    const service = new EarningsProjectorService({
      canonicalMeteringRepo: { findById } as any,
      earningsLedgerRepo: { appendEntry } as any,
      meteringProjectorStateRepo: {
        listByMeteringEventId,
        markProjected,
        markNeedsOperatorCorrection: vi.fn(),
        listByProjectorAndState: vi.fn()
      } as any
    });

    await service.projectMeteringEvent('meter_1');

    expect(appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      meteringEventId: 'meter_1',
      effectType: 'contributor_accrual',
      balanceBucket: 'withdrawable',
      amountMinor: 780,
      currency: 'USD'
    }));
    expect(markProjected).toHaveBeenCalledWith({
      meteringEventId: 'meter_1',
      projector: 'earnings'
    });
  });

  it('projects reversals into the adjusted bucket without mutating prior accrual rows', async () => {
    const appendEntry = vi.fn().mockResolvedValue({ id: 'earn_reverse_1' });
    const service = new EarningsProjectorService({
      canonicalMeteringRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'meter_2',
          request_id: 'req_2',
          attempt_no: 1,
          finalization_kind: 'reversal',
          idempotency_key: 'req_2:1:reversal',
          session_id: null,
          source_metering_event_id: 'meter_orig',
          admission_org_id: 'org_innies',
          admission_cutover_id: 'cut_1',
          admission_routing_mode: 'team-overflow-on-contributor-capacity',
          consumer_org_id: 'org_innies',
          consumer_user_id: null,
          team_consumer_id: 'innies-team',
          buyer_key_id: null,
          serving_org_id: 'org_fnf',
          provider_account_id: 'acct_1',
          token_credential_id: 'cred_1',
          capacity_owner_user_id: 'user_darryn',
          provider: 'anthropic',
          model: 'claude-sonnet',
          rate_card_version_id: 'rate_1',
          input_tokens: 0,
          output_tokens: 0,
          usage_units: 0,
          buyer_debit_minor: 0,
          contributor_earnings_minor: -780,
          currency: 'USD',
          metadata: null,
          created_at: '2026-03-20T12:10:00Z'
        })
      } as any,
      earningsLedgerRepo: { appendEntry } as any,
      meteringProjectorStateRepo: {
        listByMeteringEventId: vi.fn().mockResolvedValue([{
          metering_event_id: 'meter_2',
          projector: 'earnings',
          state: 'pending_projection',
          retry_count: 0,
          last_attempt_at: null,
          next_retry_at: null,
          last_error_code: null,
          last_error_message: null,
          projected_at: null,
          created_at: '2026-03-20T12:10:00Z',
          updated_at: '2026-03-20T12:10:00Z'
        }]),
        markProjected: vi.fn().mockResolvedValue({}),
        markNeedsOperatorCorrection: vi.fn(),
        listByProjectorAndState: vi.fn()
      } as any
    });

    await service.projectMeteringEvent('meter_2');

    expect(appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      effectType: 'contributor_reversal',
      balanceBucket: 'adjusted',
      amountMinor: -780
    }));
  });

  it('marks disallowed non-overflow earnings rows for operator correction instead of creating ledger entries', async () => {
    const appendEntry = vi.fn();
    const markNeedsOperatorCorrection = vi.fn().mockResolvedValue({});
    const service = new EarningsProjectorService({
      canonicalMeteringRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'meter_3',
          request_id: 'req_3',
          attempt_no: 1,
          finalization_kind: 'served_request',
          idempotency_key: 'req_3:1:served_request',
          session_id: null,
          source_metering_event_id: null,
          admission_org_id: 'org_fnf',
          admission_cutover_id: 'cut_1',
          admission_routing_mode: 'paid-team-capacity',
          consumer_org_id: 'org_fnf',
          consumer_user_id: 'user_darryn',
          team_consumer_id: null,
          buyer_key_id: 'buyer_1',
          serving_org_id: 'org_innies',
          provider_account_id: 'acct_2',
          token_credential_id: 'cred_2',
          capacity_owner_user_id: 'user_darryn',
          provider: 'openai',
          model: 'gpt-5-codex',
          rate_card_version_id: 'rate_2',
          input_tokens: 10,
          output_tokens: 20,
          usage_units: 30,
          buyer_debit_minor: 60,
          contributor_earnings_minor: 55,
          currency: 'USD',
          metadata: null,
          created_at: '2026-03-20T12:20:00Z'
        })
      } as any,
      earningsLedgerRepo: { appendEntry } as any,
      meteringProjectorStateRepo: {
        listByMeteringEventId: vi.fn().mockResolvedValue([{
          metering_event_id: 'meter_3',
          projector: 'earnings',
          state: 'pending_projection',
          retry_count: 1,
          last_attempt_at: null,
          next_retry_at: null,
          last_error_code: null,
          last_error_message: null,
          projected_at: null,
          created_at: '2026-03-20T12:20:00Z',
          updated_at: '2026-03-20T12:20:00Z'
        }]),
        markProjected: vi.fn(),
        markNeedsOperatorCorrection,
        listByProjectorAndState: vi.fn()
      } as any,
      now: () => new Date('2026-03-20T12:21:00Z')
    });

    await expect(service.projectMeteringEvent('meter_3')).rejects.toThrow(
      'contributor earnings are only allowed for team-overflow-on-contributor-capacity'
    );

    expect(appendEntry).not.toHaveBeenCalled();
    expect(markNeedsOperatorCorrection).toHaveBeenCalledWith(expect.objectContaining({
      meteringEventId: 'meter_3',
      projector: 'earnings',
      retryCount: 2,
      lastErrorCode: 'projection_failed'
    }));
  });

  it('retries pending and due stuck earnings projections from the backlog', async () => {
    const projectMeteringEvent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));
    const now = new Date('2026-03-20T13:00:00Z');
    const service = new EarningsProjectorService({
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      earningsLedgerRepo: { appendEntry: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByMeteringEventId: vi.fn().mockResolvedValue([]),
        markProjected: vi.fn(),
        markNeedsOperatorCorrection: vi.fn(),
        listByProjectorAndState: vi.fn()
          .mockResolvedValueOnce([{
            metering_event_id: 'meter_pending',
            projector: 'earnings',
            state: 'pending_projection',
            retry_count: 0,
            last_attempt_at: null,
            next_retry_at: null,
            last_error_code: null,
            last_error_message: null,
            projected_at: null,
            created_at: '2026-03-20T12:30:00Z',
            updated_at: '2026-03-20T12:30:00Z'
          }])
          .mockResolvedValueOnce([{
            metering_event_id: 'meter_stuck',
            projector: 'earnings',
            state: 'needs_operator_correction',
            retry_count: 3,
            last_attempt_at: '2026-03-20T12:40:00Z',
            next_retry_at: '2026-03-20T12:59:00Z',
            last_error_code: 'projection_failed',
            last_error_message: 'boom',
            projected_at: null,
            created_at: '2026-03-20T12:35:00Z',
            updated_at: '2026-03-20T12:40:00Z'
          }])
      } as any,
      now: () => now
    });
    vi.spyOn(service, 'projectMeteringEvent').mockImplementation(projectMeteringEvent);

    const result = await service.retryBacklog({ limit: 10 });

    expect(projectMeteringEvent).toHaveBeenCalledTimes(2);
    expect(projectMeteringEvent).toHaveBeenNthCalledWith(1, 'meter_pending');
    expect(projectMeteringEvent).toHaveBeenNthCalledWith(2, 'meter_stuck');
    expect(result).toEqual({
      processed: 2,
      projected: 1,
      failed: 1
    });
  });
});
