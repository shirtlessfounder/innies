import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/utils/errors.js';
import { MockSqlClient } from './testHelpers.js';
import { WalletService } from '../src/services/wallet/walletService.js';

describe('WalletService', () => {
  it('allows paid admission when the wallet balance is positive', async () => {
    const sql = new MockSqlClient();
    const walletLedgerRepo = {
      readBalance: vi.fn().mockResolvedValue({
        walletId: 'org_fnf',
        balanceMinor: 125
      })
    };
    const service = new WalletService({
      sql,
      walletLedgerRepo: walletLedgerRepo as any,
      canonicalMeteringRepo: {} as any,
      meteringProjectorStateRepo: {} as any
    });

    const result = await service.ensurePaidAdmissionEligible({
      walletId: 'org_fnf',
      trigger: 'paid_team_capacity'
    });

    expect(result).toEqual({
      walletId: 'org_fnf',
      balanceMinor: 125,
      eligible: true
    });
    expect(sql.queries[0].sql).toContain('pg_advisory_xact_lock');
    expect(walletLedgerRepo.readBalance).toHaveBeenCalledWith('org_fnf', expect.anything());
  });

  it('denies paid admission when the wallet balance is non-positive', async () => {
    const sql = new MockSqlClient();
    const service = new WalletService({
      sql,
      walletLedgerRepo: {
        readBalance: vi.fn().mockResolvedValue({
          walletId: 'org_fnf',
          balanceMinor: 0
        })
      } as any,
      canonicalMeteringRepo: {} as any,
      meteringProjectorStateRepo: {} as any
    });

    await expect(service.ensurePaidAdmissionEligible({
      walletId: 'org_fnf',
      trigger: 'paid_team_capacity'
    })).rejects.toMatchObject<AppError>({
      code: 'wallet_admission_denied',
      status: 402
    });
  });

  it('projects committed paid metering into an idempotent wallet ledger entry', async () => {
    const appendEntry = vi.fn().mockResolvedValue({ id: 'wallet_entry_1' });
    const markProjected = vi.fn().mockResolvedValue({
      metering_event_id: 'meter_1',
      projector: 'wallet',
      state: 'projected'
    });
    const service = new WalletService({
      sql: new MockSqlClient(),
      walletLedgerRepo: {
        appendEntry
      } as any,
      canonicalMeteringRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'meter_1',
          finalization_kind: 'served_request',
          consumer_org_id: 'org_fnf',
          buyer_key_id: 'buyer_1',
          buyer_debit_minor: 450,
          contributor_earnings_minor: 0,
          currency: 'USD'
        })
      } as any,
      meteringProjectorStateRepo: {
        markProjected
      } as any
    });

    await service.projectMeteringEvent('meter_1');

    expect(appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      buyerKeyId: 'buyer_1',
      meteringEventId: 'meter_1',
      effectType: 'buyer_debit',
      amountMinor: 450
    }));
    expect(markProjected).toHaveBeenCalledWith({
      meteringEventId: 'meter_1',
      projector: 'wallet'
    });
  });

  it('records manual wallet adjustments as explicit ledger rows with actor and reason', async () => {
    const appendEntry = vi.fn().mockResolvedValue({ id: 'wallet_entry_manual' });
    const service = new WalletService({
      sql: new MockSqlClient(),
      walletLedgerRepo: {
        appendEntry
      } as any,
      canonicalMeteringRepo: {} as any,
      meteringProjectorStateRepo: {} as any
    });

    await service.recordManualAdjustment({
      entryId: 'wallet_entry_manual',
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      actorApiKeyId: 'admin_key_1',
      effectType: 'manual_credit',
      amountMinor: 5000,
      reason: 'usdc top-up',
      metadata: {
        source: 'admin_console'
      }
    });

    expect(appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      entryId: 'wallet_entry_manual',
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      actorApiKeyId: 'admin_key_1',
      effectType: 'manual_credit',
      amountMinor: 5000,
      reason: 'usdc top-up'
    }));
  });

  it('allows already-admitted work to finalize below zero and blocks later paid admissions', async () => {
    const sql = new MockSqlClient();
    const appendEntry = vi.fn().mockResolvedValue({ id: 'wallet_entry_negative' });
    const readBalance = vi.fn().mockResolvedValue({
      walletId: 'org_fnf',
      balanceMinor: -125
    });
    const service = new WalletService({
      sql,
      walletLedgerRepo: {
        appendEntry,
        readBalance
      } as any,
      canonicalMeteringRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'meter_negative',
          finalization_kind: 'served_request',
          consumer_org_id: 'org_fnf',
          buyer_key_id: 'buyer_1',
          buyer_debit_minor: 250,
          contributor_earnings_minor: 0,
          currency: 'USD'
        })
      } as any,
      meteringProjectorStateRepo: {
        markProjected: vi.fn().mockResolvedValue(undefined)
      } as any
    });

    await service.projectMeteringEvent('meter_negative');

    await expect(service.ensurePaidAdmissionEligible({
      walletId: 'org_fnf',
      trigger: 'paid_team_capacity'
    })).rejects.toMatchObject<AppError>({
      code: 'wallet_admission_denied',
      status: 402
    });
    expect(appendEntry).toHaveBeenCalledWith(expect.objectContaining({
      meteringEventId: 'meter_negative',
      effectType: 'buyer_debit',
      amountMinor: 250
    }));
  });
});
