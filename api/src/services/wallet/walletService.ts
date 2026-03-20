import { AppError } from '../../utils/errors.js';
import type { SqlClient } from '../../repos/sqlClient.js';
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

export type WalletAdmissionTrigger = 'paid_team_capacity';

export class WalletService {
  constructor(private readonly deps: {
    sql: SqlClient;
    walletLedgerRepo: WalletLedgerRepository;
    canonicalMeteringRepo: CanonicalMeteringRepository;
    meteringProjectorStateRepo: MeteringProjectorStateRepository;
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
      const balance = await this.deps.walletLedgerRepo.readBalance(input.walletId, tx);
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

    for (const effect of effects) {
      await this.deps.walletLedgerRepo.appendEntry(buildWalletProjectionInput(event, effect.effectType, effect.amountMinor));
    }

    await this.deps.meteringProjectorStateRepo.markProjected({
      meteringEventId,
      projector: 'wallet'
    });
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
