import { AppError } from '../../utils/errors.js';
import type { SqlClient, TransactionContext } from '../../repos/sqlClient.js';
import type {
  CanonicalMeteringEventRow,
  CanonicalMeteringRepository
} from '../../repos/canonicalMeteringRepository.js';
import type {
  MeteringProjectorStateRepository,
  MeteringProjectorStateRow
} from '../../repos/meteringProjectorStateRepository.js';
import type {
  WalletLedgerCursor,
  WalletLedgerRepository,
  WalletLedgerRow
} from '../../repos/walletLedgerRepository.js';
import { buildWalletProjectionEffects } from '../metering/ledgerProjectionContracts.js';
import { walletIdForOrgId } from './walletBalance.js';
import type { WalletEffectType } from '../../types/phase2Contracts.js';
import type {
  AutoRechargeAttemptResult,
  AutoRechargeTrigger,
  PaymentWalletEffectType
} from '../payments/paymentTypes.js';

export type WalletAdmissionTrigger = 'paid_team_capacity';

type WalletPaymentsAdapter = {
  attemptAutoRecharge(walletId: string, trigger: AutoRechargeTrigger): Promise<AutoRechargeAttemptResult>;
  getNormalizedPaymentOutcome(input: {
    processorEffectId: string;
    effectType: PaymentWalletEffectType;
  }): Promise<{
    walletId: string;
    ownerOrgId?: string;
    processorEffectId: string;
    effectType: PaymentWalletEffectType;
    amountMinor: number;
    currency: string;
    metadata?: Record<string, unknown> | null;
  } | null>;
  markPaymentOutcomeRecorded(
    processorEffectId: string,
    db?: Pick<TransactionContext, 'query'>
  ): Promise<void>;
};

export class WalletService {
  constructor(private readonly deps: {
    sql: SqlClient;
    walletLedgerRepo: WalletLedgerRepository;
    canonicalMeteringRepo: CanonicalMeteringRepository;
    meteringProjectorStateRepo: MeteringProjectorStateRepository;
    paymentsAdapter?: WalletPaymentsAdapter;
  }) {}

  async getWalletSnapshot(walletId: string): Promise<{
    walletId: string;
    ownerOrgId: string;
    balanceMinor: number;
    currency: string;
  }> {
    const balance = await this.deps.walletLedgerRepo.readBalance(walletId);
    return {
      walletId,
      ownerOrgId: walletId,
      balanceMinor: balance.balanceMinor,
      currency: 'USD'
    };
  }

  async listWalletLedger(input: {
    walletId: string;
    limit?: number;
    cursor?: WalletLedgerCursor | null;
  }): Promise<{
    entries: WalletLedgerRow[];
    nextCursor: WalletLedgerCursor | null;
  }> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const entries = await this.deps.walletLedgerRepo.listPageByWalletId({
      walletId: input.walletId,
      limit,
      cursor: input.cursor ?? null
    });
    const last = entries[entries.length - 1];
    return {
      entries,
      nextCursor: entries.length === limit && last
        ? {
          createdAt: last.created_at,
          id: last.id
        }
        : null
    };
  }

  async ensurePaidAdmissionEligible(input: {
    walletId: string;
    trigger: WalletAdmissionTrigger;
  }): Promise<{
    walletId: string;
    balanceMinor: number;
    eligible: true;
  }> {
    return this.deps.sql.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [input.walletId]);
      let balance = await this.readBalanceWithDb(input.walletId, tx);
      if (balance.balanceMinor <= 0 && this.deps.paymentsAdapter) {
        const recharge = await this.deps.paymentsAdapter.attemptAutoRecharge(input.walletId, 'admission_blocked');
        if (recharge.kind === 'charge_succeeded') {
          await this.recordPaymentOutcomeWithDb({
            walletId: input.walletId,
            processorEffectId: recharge.processorEffectId,
            effectType: 'payment_credit'
          }, tx);
          balance = await this.readBalanceWithDb(input.walletId, tx);
        } else if (recharge.kind === 'charge_failed' || recharge.kind === 'charge_pending' || recharge.kind === 'not_configured') {
          throw new AppError(
            'wallet_admission_denied',
            402,
            'Paid admission requires a positive wallet balance',
            {
              walletId: input.walletId,
              balanceMinor: balance.balanceMinor,
              trigger: input.trigger,
              recharge
            }
          );
        }
      }

      if (balance.balanceMinor <= 0) {
        throw new AppError(
          'wallet_admission_denied',
          402,
          'Paid admission requires a positive wallet balance',
          {
            walletId: input.walletId,
            balanceMinor: balance.balanceMinor,
            trigger: input.trigger
          }
        );
      }

      return {
        walletId: input.walletId,
        balanceMinor: balance.balanceMinor,
        eligible: true as const
      };
    });
  }

  async projectMeteringEvent(meteringEventId: string): Promise<void> {
    const event = await this.deps.canonicalMeteringRepo.findById(meteringEventId);
    if (!event) {
      throw new AppError('not_found', 404, 'Canonical metering event not found', {
        meteringEventId
      });
    }

    const effects = buildWalletProjectionEffects({
      meteringEventId: event.id,
      finalizationKind: event.finalization_kind,
      buyerDebitMinor: event.buyer_debit_minor,
      contributorEarningsMinor: event.contributor_earnings_minor
    });

    await this.deps.sql.transaction(async (tx) => {
      const walletId = walletIdForOrgId(event.consumer_org_id);
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [walletId]);
      const balanceBefore = await this.readBalanceWithDb(walletId, tx);

      for (const effect of effects) {
        await this.appendWalletEntryWithDb(
          buildWalletProjectionInput(event, effect.effectType, effect.amountMinor),
          tx
        );
      }

      const balanceAfter = await this.readBalanceWithDb(walletId, tx);
      if (
        this.deps.paymentsAdapter
        && effects.some((effect) => effect.effectType === 'buyer_debit')
        && balanceBefore.balanceMinor >= 0
        && balanceAfter.balanceMinor < 0
      ) {
        const recharge = await this.deps.paymentsAdapter.attemptAutoRecharge(walletId, 'post_finalization_negative');
        if (recharge.kind === 'charge_succeeded') {
          await this.recordPaymentOutcomeWithDb({
            walletId,
            processorEffectId: recharge.processorEffectId,
            effectType: 'payment_credit'
          }, tx);
        }
      }
    });

    await this.deps.meteringProjectorStateRepo.markProjected({
      meteringEventId,
      projector: 'wallet'
    });
  }

  async recordPaymentOutcome(input: {
    walletId: string;
    processorEffectId: string;
    effectType: PaymentWalletEffectType;
  }): Promise<WalletLedgerRow> {
    return this.recordPaymentOutcomeWithDb(input);
  }

  recordManualAdjustment(input: {
    entryId?: string;
    walletId: string;
    ownerOrgId: string;
    actorUserId?: string | null;
    actorApiKeyId?: string | null;
    effectType: Extract<WalletEffectType, 'manual_credit' | 'manual_debit'>;
    amountMinor: number;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<WalletLedgerRow> {
    return this.deps.walletLedgerRepo.appendEntry({
      entryId: input.entryId,
      walletId: input.walletId,
      ownerOrgId: input.ownerOrgId,
      effectType: input.effectType,
      amountMinor: input.amountMinor,
      actorUserId: input.actorUserId ?? null,
      actorApiKeyId: input.actorApiKeyId ?? null,
      reason: input.reason,
      metadata: input.metadata
    });
  }

  listWalletProjectionBacklog(limit = 100): Promise<MeteringProjectorStateRow[]> {
    return this.deps.meteringProjectorStateRepo.listOutstandingByProjector({
      projector: 'wallet',
      limit
    });
  }

  retryWalletProjection(meteringEventId: string): Promise<MeteringProjectorStateRow> {
    return this.deps.meteringProjectorStateRepo.requeueForRetry({
      meteringEventId,
      projector: 'wallet'
    });
  }

  walletIdForOrgId(orgId: string): string {
    return walletIdForOrgId(orgId);
  }

  private async recordPaymentOutcomeWithDb(
    input: {
      walletId: string;
      processorEffectId: string;
      effectType: PaymentWalletEffectType;
    },
    tx?: Parameters<WalletLedgerRepository['appendEntryWithDb']>[1]
  ): Promise<WalletLedgerRow> {
    const paymentsAdapter = this.deps.paymentsAdapter;
    if (!paymentsAdapter) {
      throw new Error('payments adapter not configured');
    }

    const outcome = await paymentsAdapter.getNormalizedPaymentOutcome({
      processorEffectId: input.processorEffectId,
      effectType: input.effectType
    });
    if (!outcome) {
      throw new AppError('payment_outcome_missing', 404, 'Normalized payment outcome not found', {
        processorEffectId: input.processorEffectId,
        effectType: input.effectType
      });
    }

    const row = await this.appendWalletEntryWithDb({
      walletId: input.walletId,
      ownerOrgId: outcome.ownerOrgId ?? input.walletId,
      effectType: outcome.effectType,
      amountMinor: outcome.amountMinor,
      currency: outcome.currency,
      processorEffectId: outcome.processorEffectId,
      metadata: outcome.metadata ?? undefined
    }, tx);
    await paymentsAdapter.markPaymentOutcomeRecorded(input.processorEffectId, tx);
    return row;
  }

  private appendWalletEntryWithDb(
    input: Parameters<WalletLedgerRepository['appendEntry']>[0],
    tx?: Parameters<WalletLedgerRepository['appendEntryWithDb']>[1]
  ): Promise<WalletLedgerRow> {
    const repo = this.deps.walletLedgerRepo as WalletLedgerRepository & {
      appendEntryWithDb?: (entry: Parameters<WalletLedgerRepository['appendEntry']>[0], db: Parameters<WalletLedgerRepository['appendEntryWithDb']>[1]) => Promise<WalletLedgerRow>;
    };
    if (tx && typeof repo.appendEntryWithDb === 'function') {
      return repo.appendEntryWithDb(input, tx);
    }
    return repo.appendEntry(input);
  }

  private readBalanceWithDb(
    walletId: string,
    tx?: Parameters<WalletLedgerRepository['readBalance']>[1]
  ): Promise<{ walletId: string; balanceMinor: number }> {
    const repo = this.deps.walletLedgerRepo as WalletLedgerRepository & {
      readBalance?: (walletId: string, db?: Parameters<WalletLedgerRepository['readBalance']>[1]) => Promise<{ walletId: string; balanceMinor: number }>;
    };
    if (typeof repo.readBalance === 'function') {
      return repo.readBalance(walletId, tx);
    }
    return Promise.resolve({
      walletId,
      balanceMinor: 0
    });
  }

}

function buildWalletProjectionInput(
  event: CanonicalMeteringEventRow,
  effectType: Extract<WalletEffectType, 'buyer_debit' | 'buyer_correction' | 'buyer_reversal'>,
  amountMinor: number
) {
  return {
    walletId: walletIdForOrgId(event.consumer_org_id),
    ownerOrgId: event.consumer_org_id,
    buyerKeyId: event.buyer_key_id,
    meteringEventId: event.id,
    effectType,
    amountMinor,
    currency: event.currency
  };
}
