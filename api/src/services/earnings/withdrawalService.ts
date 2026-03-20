import type { SqlClient, TransactionContext } from '../../repos/sqlClient.js';
import type { CanonicalMeteringRepository } from '../../repos/canonicalMeteringRepository.js';
import type {
  EarningsLedgerRepository,
  EarningsLedgerRow
} from '../../repos/earningsLedgerRepository.js';
import type {
  MeteringProjectorStateRepository,
  MeteringProjectorStateRow
} from '../../repos/meteringProjectorStateRepository.js';
import type {
  CreateWithdrawalRequestInput,
  WithdrawalRequestRepository,
  WithdrawalRequestRow
} from '../../repos/withdrawalRequestRepository.js';
import { EarningsLedgerRepository as EarningsLedgerRepositoryImpl } from '../../repos/earningsLedgerRepository.js';
import { WithdrawalRequestRepository as WithdrawalRequestRepositoryImpl } from '../../repos/withdrawalRequestRepository.js';

type WithdrawalServiceDeps = {
  sql: Pick<SqlClient, 'transaction'>;
  earningsLedgerRepo: Pick<EarningsLedgerRepository, 'appendEntry' | 'listByOwnerOrgAndContributorUserId'>;
  withdrawalRequestRepo: Pick<
    WithdrawalRequestRepository,
    'findById' | 'listByOwnerOrgAndContributorUserId' | 'listByOwnerOrgId' | 'transitionStatus'
  >;
  canonicalMeteringRepo: Pick<CanonicalMeteringRepository, 'findById'>;
  meteringProjectorStateRepo: Pick<MeteringProjectorStateRepository, 'listByProjectorAndState'>;
  repoFactory?: {
    earningsLedger?: (tx: TransactionContext) => Pick<EarningsLedgerRepository, 'appendEntry' | 'listByOwnerOrgAndContributorUserId'>;
    withdrawalRequests?: (tx: TransactionContext) => Pick<WithdrawalRequestRepository, 'create' | 'findById' | 'transitionStatus'>;
  };
};

export type ContributorEarningsSummary = {
  pendingMinor: number;
  withdrawableMinor: number;
  reservedForPayoutMinor: number;
  settledMinor: number;
  adjustedMinor: number;
};

export class WithdrawalService {
  constructor(private readonly deps: WithdrawalServiceDeps) {}

  async getContributorSummary(input: {
    ownerOrgId: string;
    contributorUserId: string;
  }): Promise<ContributorEarningsSummary> {
    const ledgerEntries = await this.deps.earningsLedgerRepo.listByOwnerOrgAndContributorUserId(input);
    const pendingMinor = await this.computePendingMinor(input);
    const posted = summarizePostedLedger(ledgerEntries);

    return {
      pendingMinor,
      withdrawableMinor: posted.withdrawableMinor,
      reservedForPayoutMinor: posted.reservedForPayoutMinor,
      settledMinor: posted.settledMinor,
      adjustedMinor: posted.adjustedMinor
    };
  }

  async listContributorHistory(input: {
    ownerOrgId: string;
    contributorUserId: string;
  }): Promise<EarningsLedgerRow[]> {
    return this.deps.earningsLedgerRepo.listByOwnerOrgAndContributorUserId(input);
  }

  async listContributorWithdrawals(input: {
    ownerOrgId: string;
    contributorUserId: string;
  }): Promise<WithdrawalRequestRow[]> {
    return this.deps.withdrawalRequestRepo.listByOwnerOrgAndContributorUserId(input);
  }

  async createWithdrawalRequest(input: CreateWithdrawalRequestInput): Promise<WithdrawalRequestRow> {
    return this.deps.sql.transaction(async (tx) => {
      await tx.query(
        'select pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [input.ownerOrgId, input.contributorUserId]
      );

      const { earningsLedgerRepo: txEarningsLedgerRepo, withdrawalRequestRepo: txWithdrawalRequestRepo } = this.buildTxRepos(tx);

      const ledgerEntries = await txEarningsLedgerRepo.listByOwnerOrgAndContributorUserId({
        ownerOrgId: input.ownerOrgId,
        contributorUserId: input.contributorUserId
      });
      const posted = summarizePostedLedger(ledgerEntries);
      if (input.amountMinor > Math.max(0, posted.withdrawableMinor)) {
        throw new Error('withdrawal amount exceeds withdrawable earnings');
      }

      const created = await txWithdrawalRequestRepo.create(input);
      await txEarningsLedgerRepo.appendEntry({
        ownerOrgId: input.ownerOrgId,
        contributorUserId: input.contributorUserId,
        effectType: 'withdrawal_reserve',
        balanceBucket: 'reserved_for_payout',
        amountMinor: input.amountMinor,
        currency: input.currency ?? 'USD',
        actorUserId: input.requestedByUserId,
        reason: input.note ?? 'withdrawal requested',
        withdrawalRequestId: created.id,
        metadata: {
          destination: input.destination
        }
      });

      return created;
    });
  }

  async approveWithdrawal(input: {
    withdrawalRequestId: string;
    actorUserId: string | null;
    actorApiKeyId: string | null;
    reason?: string | null;
  }): Promise<WithdrawalRequestRow> {
    return this.deps.sql.transaction(async (tx) => {
      const { earningsLedgerRepo, withdrawalRequestRepo } = this.buildTxRepos(tx);
      const request = await this.requireWithdrawal(withdrawalRequestRepo, input.withdrawalRequestId);

      if (request.status === 'requested') {
        await withdrawalRequestRepo.transitionStatus({
          id: request.id,
          nextStatus: 'under_review',
          actedByUserId: input.actorUserId,
          actedByApiKeyId: input.actorApiKeyId
        });
        return withdrawalRequestRepo.transitionStatus({
          id: request.id,
          nextStatus: 'approved',
          actedByUserId: input.actorUserId,
          actedByApiKeyId: input.actorApiKeyId
        });
      }

      if (request.status === 'settlement_failed') {
        await earningsLedgerRepo.appendEntry({
          ownerOrgId: request.owner_org_id,
          contributorUserId: request.contributor_user_id,
          effectType: 'withdrawal_reserve',
          balanceBucket: 'reserved_for_payout',
          amountMinor: request.amount_minor,
          currency: request.currency,
          actorUserId: input.actorUserId,
          actorApiKeyId: input.actorApiKeyId,
          reason: input.reason ?? 'withdrawal re-approved after settlement failure',
          withdrawalRequestId: request.id
        });
      }

      return withdrawalRequestRepo.transitionStatus({
        id: request.id,
        nextStatus: 'approved',
        actedByUserId: input.actorUserId,
        actedByApiKeyId: input.actorApiKeyId
      });
    });
  }

  async rejectWithdrawal(input: {
    withdrawalRequestId: string;
    actorUserId: string | null;
    actorApiKeyId: string | null;
    reason: string;
  }): Promise<WithdrawalRequestRow> {
    return this.deps.sql.transaction(async (tx) => {
      const { earningsLedgerRepo, withdrawalRequestRepo } = this.buildTxRepos(tx);
      const request = await this.requireWithdrawal(withdrawalRequestRepo, input.withdrawalRequestId);

      if (request.status === 'requested') {
        await withdrawalRequestRepo.transitionStatus({
          id: request.id,
          nextStatus: 'under_review',
          actedByUserId: input.actorUserId,
          actedByApiKeyId: input.actorApiKeyId
        });
      }

      const rejected = await withdrawalRequestRepo.transitionStatus({
        id: request.id,
        nextStatus: 'rejected',
        actedByUserId: input.actorUserId,
        actedByApiKeyId: input.actorApiKeyId
      });

      if (request.status !== 'settlement_failed') {
        await earningsLedgerRepo.appendEntry({
          ownerOrgId: request.owner_org_id,
          contributorUserId: request.contributor_user_id,
          effectType: 'withdrawal_release',
          balanceBucket: 'withdrawable',
          amountMinor: request.amount_minor,
          currency: request.currency,
          actorUserId: input.actorUserId,
          actorApiKeyId: input.actorApiKeyId,
          reason: input.reason,
          withdrawalRequestId: request.id
        });
      }

      return rejected;
    });
  }

  async markSettlementFailed(input: {
    withdrawalRequestId: string;
    actorUserId: string | null;
    actorApiKeyId: string | null;
    settlementFailureReason: string;
    adjustmentMinor?: number;
    adjustmentReason?: string | null;
  }): Promise<WithdrawalRequestRow> {
    return this.deps.sql.transaction(async (tx) => {
      const { earningsLedgerRepo, withdrawalRequestRepo } = this.buildTxRepos(tx);
      const request = await this.requireWithdrawal(withdrawalRequestRepo, input.withdrawalRequestId);
      const updated = await withdrawalRequestRepo.transitionStatus({
        id: request.id,
        nextStatus: 'settlement_failed',
        actedByUserId: input.actorUserId,
        actedByApiKeyId: input.actorApiKeyId,
        settlementFailureReason: input.settlementFailureReason
      });

      await earningsLedgerRepo.appendEntry({
        ownerOrgId: request.owner_org_id,
        contributorUserId: request.contributor_user_id,
        effectType: 'withdrawal_release',
        balanceBucket: 'withdrawable',
        amountMinor: request.amount_minor,
        currency: request.currency,
        actorUserId: input.actorUserId,
        actorApiKeyId: input.actorApiKeyId,
        reason: input.settlementFailureReason,
        withdrawalRequestId: request.id
      });

      await this.appendAdjustmentIfNeeded(earningsLedgerRepo, updated, {
        actorUserId: input.actorUserId,
        actorApiKeyId: input.actorApiKeyId,
        adjustmentMinor: input.adjustmentMinor,
        adjustmentReason: input.adjustmentReason ?? input.settlementFailureReason
      });

      return updated;
    });
  }

  async markSettled(input: {
    withdrawalRequestId: string;
    actorUserId: string | null;
    actorApiKeyId: string | null;
    settlementReference: string;
    adjustmentMinor?: number;
    adjustmentReason?: string | null;
  }): Promise<WithdrawalRequestRow> {
    return this.deps.sql.transaction(async (tx) => {
      const { earningsLedgerRepo, withdrawalRequestRepo } = this.buildTxRepos(tx);
      const request = await this.requireWithdrawal(withdrawalRequestRepo, input.withdrawalRequestId);
      const updated = await withdrawalRequestRepo.transitionStatus({
        id: request.id,
        nextStatus: 'settled',
        actedByUserId: input.actorUserId,
        actedByApiKeyId: input.actorApiKeyId,
        settlementReference: input.settlementReference
      });

      await earningsLedgerRepo.appendEntry({
        ownerOrgId: request.owner_org_id,
        contributorUserId: request.contributor_user_id,
        effectType: 'payout_settlement',
        balanceBucket: 'settled',
        amountMinor: request.amount_minor,
        currency: request.currency,
        actorUserId: input.actorUserId,
        actorApiKeyId: input.actorApiKeyId,
        reason: 'withdrawal settled',
        withdrawalRequestId: request.id,
        payoutReference: input.settlementReference
      });

      await this.appendAdjustmentIfNeeded(earningsLedgerRepo, updated, {
        actorUserId: input.actorUserId,
        actorApiKeyId: input.actorApiKeyId,
        adjustmentMinor: input.adjustmentMinor,
        adjustmentReason: input.adjustmentReason ?? 'payout adjustment'
      });

      return updated;
    });
  }

  async listAdminWithdrawals(ownerOrgId: string): Promise<WithdrawalRequestRow[]> {
    return this.deps.withdrawalRequestRepo.listByOwnerOrgId(ownerOrgId);
  }

  private async computePendingMinor(input: {
    ownerOrgId: string;
    contributorUserId: string;
  }): Promise<number> {
    const pending = await this.deps.meteringProjectorStateRepo.listByProjectorAndState({
      projector: 'earnings',
      state: 'pending_projection'
    });
    const stuck = await this.deps.meteringProjectorStateRepo.listByProjectorAndState({
      projector: 'earnings',
      state: 'needs_operator_correction'
    });

    let total = 0;
    for (const row of [...pending, ...stuck]) {
      total += await this.pendingMinorForRow(row, input);
    }

    return total;
  }

  private async pendingMinorForRow(
    row: Pick<MeteringProjectorStateRow, 'metering_event_id'>,
    input: { ownerOrgId: string; contributorUserId: string; }
  ): Promise<number> {
    const event = await this.deps.canonicalMeteringRepo.findById(row.metering_event_id);
    if (!event) {
      return 0;
    }
    if (event.serving_org_id !== input.ownerOrgId) {
      return 0;
    }
    if (event.capacity_owner_user_id !== input.contributorUserId) {
      return 0;
    }
    if (event.admission_routing_mode !== 'team-overflow-on-contributor-capacity') {
      return 0;
    }
    return event.contributor_earnings_minor;
  }

  private buildTxRepos(tx: TransactionContext): {
    earningsLedgerRepo: Pick<EarningsLedgerRepository, 'appendEntry' | 'listByOwnerOrgAndContributorUserId'>;
    withdrawalRequestRepo: Pick<WithdrawalRequestRepository, 'create' | 'findById' | 'transitionStatus'>;
  } {
    return {
      earningsLedgerRepo: this.deps.repoFactory?.earningsLedger?.(tx)
        ?? new EarningsLedgerRepositoryImpl(tx as unknown as SqlClient),
      withdrawalRequestRepo: this.deps.repoFactory?.withdrawalRequests?.(tx)
        ?? new WithdrawalRequestRepositoryImpl(tx as unknown as SqlClient)
    };
  }

  private async appendAdjustmentIfNeeded(
    earningsLedgerRepo: Pick<EarningsLedgerRepository, 'appendEntry'>,
    request: WithdrawalRequestRow,
    input: {
      actorUserId: string | null;
      actorApiKeyId: string | null;
      adjustmentMinor?: number;
      adjustmentReason?: string | null;
    }
  ): Promise<void> {
    if (!input.adjustmentMinor) {
      return;
    }

    await earningsLedgerRepo.appendEntry({
      ownerOrgId: request.owner_org_id,
      contributorUserId: request.contributor_user_id,
      effectType: 'payout_adjustment',
      balanceBucket: 'adjusted',
      amountMinor: input.adjustmentMinor,
      currency: request.currency,
      actorUserId: input.actorUserId,
      actorApiKeyId: input.actorApiKeyId,
      reason: input.adjustmentReason ?? 'payout adjustment',
      withdrawalRequestId: request.id,
      payoutReference: request.settlement_reference
    });
  }

  private async requireWithdrawal(
    withdrawalRequestRepo: Pick<WithdrawalRequestRepository, 'findById'>,
    id: string
  ): Promise<WithdrawalRequestRow> {
    const request = await withdrawalRequestRepo.findById(id);
    if (!request) {
      throw new Error(`withdrawal request not found: ${id}`);
    }
    return request;
  }
}

function sumLedgerAmounts(
  rows: Array<Pick<EarningsLedgerRow, 'effect_type' | 'amount_minor'>>,
  effectTypes: readonly string[]
): number {
  return rows
    .filter((row) => effectTypes.includes(row.effect_type))
    .reduce((sum, row) => sum + row.amount_minor, 0);
}

function summarizePostedLedger(rows: Array<Pick<EarningsLedgerRow, 'effect_type' | 'amount_minor'>>): {
  withdrawableMinor: number;
  reservedForPayoutMinor: number;
  settledMinor: number;
  adjustedMinor: number;
} {
  const accrualMinor = sumLedgerAmounts(rows, ['contributor_accrual']);
  const adjustedMinor = sumLedgerAmounts(rows, [
    'contributor_correction',
    'contributor_reversal',
    'payout_adjustment'
  ]);
  const reserveMinor = sumLedgerAmounts(rows, ['withdrawal_reserve']);
  const releaseMinor = sumLedgerAmounts(rows, ['withdrawal_release']);
  const settledMinor = sumLedgerAmounts(rows, ['payout_settlement']);
  const reservedForPayoutMinor = reserveMinor - releaseMinor - settledMinor;
  const withdrawableMinor = accrualMinor + adjustedMinor - reservedForPayoutMinor - settledMinor;

  return {
    withdrawableMinor,
    reservedForPayoutMinor,
    settledMinor,
    adjustedMinor
  };
}
