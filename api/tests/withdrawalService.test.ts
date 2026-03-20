import { describe, expect, it, vi } from 'vitest';
import { WithdrawalService } from '../src/services/earnings/withdrawalService.js';

describe('WithdrawalService', () => {
  it('derives pending, withdrawable, reserved, settled, and adjusted balances from projector state plus ledger entries', async () => {
    const service = new WithdrawalService({
      sql: { transaction: vi.fn() } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([
          { effect_type: 'contributor_accrual', amount_minor: 900 },
          { effect_type: 'contributor_correction', amount_minor: -50 },
          { effect_type: 'withdrawal_reserve', amount_minor: 200 },
          { effect_type: 'payout_settlement', amount_minor: 100 }
        ])
      } as any,
      withdrawalRequestRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([])
      } as any,
      canonicalMeteringRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'meter_pending',
          serving_org_id: 'org_fnf',
          capacity_owner_user_id: 'user_darryn',
          admission_routing_mode: 'team-overflow-on-contributor-capacity',
          contributor_earnings_minor: 75
        })
      } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn()
          .mockResolvedValueOnce([{
            metering_event_id: 'meter_pending',
            projector: 'earnings',
            state: 'pending_projection'
          }])
          .mockResolvedValueOnce([])
      } as any
    });

    const summary = await service.getContributorSummary({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });

    expect(summary).toEqual({
      pendingMinor: 75,
      withdrawableMinor: 650,
      reservedForPayoutMinor: 100,
      settledMinor: 100,
      adjustedMinor: -50
    });
  });

  it('creates withdrawal requests only against withdrawable funds and records the reserve effect immediately', async () => {
    const txQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const create = vi.fn().mockResolvedValue({
      id: 'withdraw_1',
      owner_org_id: 'org_fnf',
      contributor_user_id: 'user_darryn',
      amount_minor: 400,
      currency: 'USD',
      destination: { rail: 'manual_usdc', address: '0xabc' },
      status: 'requested',
      requested_by_user_id: 'user_darryn',
      reviewed_by_user_id: null,
      reviewed_by_api_key_id: null,
      note: null,
      settlement_reference: null,
      settlement_failure_reason: null,
      created_at: '2026-03-20T12:00:00Z',
      updated_at: '2026-03-20T12:00:00Z'
    });
    const appendEntry = vi.fn().mockResolvedValue({ id: 'earn_reserve_1' });
    const service = new WithdrawalService({
      sql: {
        transaction: vi.fn(async (run) => run({ query: txQuery }))
      } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([
          { effect_type: 'contributor_accrual', amount_minor: 700 }
        ]),
        appendEntry
      } as any,
      withdrawalRequestRepo: {
        create,
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([])
      } as any,
      repoFactory: {
        earningsLedger: vi.fn().mockReturnValue({
          listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([
            { effect_type: 'contributor_accrual', amount_minor: 700 }
          ]),
          appendEntry
        }),
        withdrawalRequests: vi.fn().mockReturnValue({
          create
        })
      },
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn().mockResolvedValue([])
      } as any
    });

    const request = await service.createWithdrawalRequest({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      requestedByUserId: 'user_darryn',
      amountMinor: 400,
      destination: { rail: 'manual_usdc', address: '0xabc' }
    });

    expect(request.id).toBe('withdraw_1');
    expect(txQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['org_fnf', 'user_darryn']
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      amountMinor: 400
    }));
    expect(appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      effectType: 'withdrawal_reserve',
      balanceBucket: 'reserved_for_payout',
      amountMinor: 400,
      withdrawalRequestId: 'withdraw_1'
    }));
  });

  it('uses org-scoped reads for contributor history and withdrawals', async () => {
    const listHistory = vi.fn().mockResolvedValue([{ id: 'earn_1' }]);
    const listWithdrawals = vi.fn().mockResolvedValue([{ id: 'withdraw_1' }]);
    const service = new WithdrawalService({
      sql: { transaction: vi.fn() } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: listHistory,
        appendEntry: vi.fn()
      } as any,
      withdrawalRequestRepo: {
        listByOwnerOrgAndContributorUserId: listWithdrawals
      } as any,
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn().mockResolvedValue([])
      } as any
    });

    await service.listContributorHistory({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });
    await service.listContributorWithdrawals({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });

    expect(listHistory).toHaveBeenCalledWith({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });
    expect(listWithdrawals).toHaveBeenCalledWith({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });
  });

  it('rejects withdrawal requests that exceed withdrawable funds', async () => {
    const service = new WithdrawalService({
      sql: {
        transaction: vi.fn(async (run) => run({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }))
      } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([
          { effect_type: 'contributor_accrual', amount_minor: 150 }
        ]),
        appendEntry: vi.fn()
      } as any,
      withdrawalRequestRepo: {
        create: vi.fn(),
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([])
      } as any,
      repoFactory: {
        earningsLedger: vi.fn().mockReturnValue({
          listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([
            { effect_type: 'contributor_accrual', amount_minor: 150 }
          ]),
          appendEntry: vi.fn()
        }),
        withdrawalRequests: vi.fn().mockReturnValue({
          create: vi.fn()
        })
      },
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn().mockResolvedValue([])
      } as any
    });

    await expect(service.createWithdrawalRequest({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      requestedByUserId: 'user_darryn',
      amountMinor: 200,
      destination: { rail: 'manual_usdc', address: '0xabc' }
    })).rejects.toThrow('withdrawal amount exceeds withdrawable earnings');
  });

  it('releases reserved funds on rejection and settlement failure, and records settlement plus adjustment effects on success', async () => {
    const appendEntry = vi.fn().mockResolvedValue({ id: 'entry_1' });
    const transitionStatus = vi.fn()
      .mockResolvedValueOnce({ id: 'withdraw_2', status: 'under_review', amount_minor: 250 })
      .mockResolvedValueOnce({ id: 'withdraw_2', status: 'rejected', amount_minor: 250 })
      .mockResolvedValueOnce({ id: 'withdraw_3', status: 'settlement_failed', amount_minor: 300 })
      .mockResolvedValueOnce({ id: 'withdraw_4', status: 'settled', amount_minor: 500 });
    const findById = vi.fn()
      .mockResolvedValueOnce({
        id: 'withdraw_2',
        owner_org_id: 'org_fnf',
        contributor_user_id: 'user_darryn',
        amount_minor: 250,
        status: 'requested'
      })
      .mockResolvedValueOnce({
        id: 'withdraw_3',
        owner_org_id: 'org_fnf',
        contributor_user_id: 'user_darryn',
        amount_minor: 300,
        status: 'approved'
      })
      .mockResolvedValueOnce({
        id: 'withdraw_4',
        owner_org_id: 'org_fnf',
        contributor_user_id: 'user_darryn',
        amount_minor: 500,
        status: 'approved'
      });

    const service = new WithdrawalService({
      sql: { transaction: vi.fn() } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([]),
        appendEntry
      } as any,
      withdrawalRequestRepo: {
        findById,
        transitionStatus,
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([])
      } as any,
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn().mockResolvedValue([])
      } as any
    });

    await service.rejectWithdrawal({
      withdrawalRequestId: 'withdraw_2',
      actorUserId: 'admin_1',
      actorApiKeyId: null,
      reason: 'duplicate request'
    });
    await service.markSettlementFailed({
      withdrawalRequestId: 'withdraw_3',
      actorUserId: 'admin_1',
      actorApiKeyId: null,
      settlementFailureReason: 'bank rejected payout'
    });
    await service.markSettled({
      withdrawalRequestId: 'withdraw_4',
      actorUserId: 'admin_1',
      actorApiKeyId: null,
      settlementReference: 'wire_123',
      adjustmentMinor: -15,
      adjustmentReason: 'network fee'
    });

    expect(appendEntry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      effectType: 'withdrawal_release',
      balanceBucket: 'withdrawable',
      amountMinor: 250,
      withdrawalRequestId: 'withdraw_2'
    }));
    expect(appendEntry).toHaveBeenNthCalledWith(2, expect.objectContaining({
      effectType: 'withdrawal_release',
      balanceBucket: 'withdrawable',
      amountMinor: 300,
      withdrawalRequestId: 'withdraw_3'
    }));
    expect(appendEntry).toHaveBeenNthCalledWith(3, expect.objectContaining({
      effectType: 'payout_settlement',
      balanceBucket: 'settled',
      amountMinor: 500,
      withdrawalRequestId: 'withdraw_4',
      payoutReference: 'wire_123'
    }));
    expect(appendEntry).toHaveBeenNthCalledWith(4, expect.objectContaining({
      effectType: 'payout_adjustment',
      balanceBucket: 'adjusted',
      amountMinor: -15,
      withdrawalRequestId: 'withdraw_4',
      reason: 'network fee'
    }));
  });

  it('propagates admin api-key attribution through review transitions and payout ledger rows', async () => {
    const appendEntry = vi.fn().mockResolvedValue({ id: 'entry_1' });
    const transitionStatus = vi.fn()
      .mockResolvedValueOnce({ id: 'withdraw_7', status: 'under_review', amount_minor: 250 })
      .mockResolvedValueOnce({ id: 'withdraw_7', status: 'approved', amount_minor: 250 });
    const findById = vi.fn().mockResolvedValueOnce({
      id: 'withdraw_7',
      owner_org_id: 'org_fnf',
      contributor_user_id: 'user_darryn',
      amount_minor: 250,
      currency: 'USD',
      status: 'requested'
    });

    const service = new WithdrawalService({
      sql: { transaction: vi.fn() } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([]),
        appendEntry
      } as any,
      withdrawalRequestRepo: {
        findById,
        transitionStatus,
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([])
      } as any,
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn().mockResolvedValue([])
      } as any
    });

    await service.approveWithdrawal({
      withdrawalRequestId: 'withdraw_7',
      actorUserId: null,
      actorApiKeyId: 'key_admin_1',
      reason: 'review complete'
    });

    expect(transitionStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: 'withdraw_7',
      nextStatus: 'under_review',
      actedByUserId: null,
      actedByApiKeyId: 'key_admin_1'
    }));
    expect(transitionStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'withdraw_7',
      nextStatus: 'approved',
      actedByUserId: null,
      actedByApiKeyId: 'key_admin_1'
    }));
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('bubbles reserve-write failures from the transaction path so the request insert can roll back', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'withdraw_9',
      owner_org_id: 'org_fnf',
      contributor_user_id: 'user_darryn',
      amount_minor: 400,
      currency: 'USD'
    });
    const appendEntry = vi.fn().mockRejectedValue(new Error('reserve write failed'));
    const transaction = vi.fn(async (run) => run({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }));
    const service = new WithdrawalService({
      sql: { transaction } as any,
      earningsLedgerRepo: {
        listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([])
      } as any,
      withdrawalRequestRepo: {} as any,
      repoFactory: {
        earningsLedger: vi.fn().mockReturnValue({
          listByOwnerOrgAndContributorUserId: vi.fn().mockResolvedValue([
            { effect_type: 'contributor_accrual', amount_minor: 700 }
          ]),
          appendEntry
        }),
        withdrawalRequests: vi.fn().mockReturnValue({
          create
        })
      },
      canonicalMeteringRepo: { findById: vi.fn() } as any,
      meteringProjectorStateRepo: {
        listByProjectorAndState: vi.fn().mockResolvedValue([])
      } as any
    });

    await expect(service.createWithdrawalRequest({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      requestedByUserId: 'user_darryn',
      amountMinor: 400,
      destination: { rail: 'manual_usdc', address: '0xabc' }
    })).rejects.toThrow('reserve write failed');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });
});
