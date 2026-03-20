import type {
  CanonicalMeteringEventRow,
  CanonicalMeteringRepository
} from '../../repos/canonicalMeteringRepository.js';
import type {
  EarningsLedgerRepository,
  EarningsLedgerEntryInput
} from '../../repos/earningsLedgerRepository.js';
import type {
  MeteringProjectorStateRepository,
  MeteringProjectorStateRow
} from '../../repos/meteringProjectorStateRepository.js';
import { buildEarningsProjectionEffects } from '../metering/ledgerProjectionContracts.js';

const DEFAULT_BACKLOG_LIMIT = 50;
const DEFAULT_MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 60_000;

type EarningsProjectorDeps = {
  canonicalMeteringRepo: Pick<CanonicalMeteringRepository, 'findById'>;
  earningsLedgerRepo: Pick<EarningsLedgerRepository, 'appendEntry'>;
  meteringProjectorStateRepo: Pick<
    MeteringProjectorStateRepository,
    'listByMeteringEventId' | 'markProjected' | 'markNeedsOperatorCorrection' | 'listByProjectorAndState'
  >;
  now?: () => Date;
  maxRetries?: number;
};

export type EarningsProjectionBacklogItem = {
  meteringEventId: string;
  requestId: string | null;
  contributorUserId: string | null;
  ownerOrgId: string | null;
  routingMode: string | null;
  contributorEarningsMinor: number | null;
  state: MeteringProjectorStateRow['state'];
  retryCount: number;
  nextRetryAt: string | null;
  updatedAt: string;
};

export class EarningsProjectorService {
  private readonly now: () => Date;
  private readonly maxRetries: number;

  constructor(private readonly deps: EarningsProjectorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxRetries = Math.max(1, deps.maxRetries ?? DEFAULT_MAX_RETRIES);
  }

  async projectMeteringEvent(meteringEventId: string): Promise<void> {
    const projectorState = await this.loadProjectorState(meteringEventId);

    try {
      const event = await this.requireMeteringEvent(meteringEventId);
      this.assertProjectableEarningsEvent(event);

      const drafts = buildEarningsProjectionEffects({
        meteringEventId: event.id,
        finalizationKind: event.finalization_kind,
        buyerDebitMinor: event.buyer_debit_minor,
        contributorEarningsMinor: event.contributor_earnings_minor
      });

      for (const draft of drafts) {
        await this.deps.earningsLedgerRepo.appendEntry(this.buildLedgerEntry(event, draft));
      }

      await this.deps.meteringProjectorStateRepo.markProjected({
        meteringEventId,
        projector: 'earnings'
      });
    } catch (error) {
      await this.deps.meteringProjectorStateRepo.markNeedsOperatorCorrection({
        meteringEventId,
        projector: 'earnings',
        retryCount: (projectorState?.retry_count ?? 0) + 1,
        lastAttemptAt: this.now(),
        nextRetryAt: this.buildNextRetryAt((projectorState?.retry_count ?? 0) + 1),
        lastErrorCode: 'projection_failed',
        lastErrorMessage: error instanceof Error ? error.message : 'unknown projector failure'
      });
      throw error;
    }
  }

  async retryBacklog(input?: { limit?: number }): Promise<{
    processed: number;
    projected: number;
    failed: number;
  }> {
    const candidates = await this.listRetryCandidates(input?.limit ?? DEFAULT_BACKLOG_LIMIT);

    let projected = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.projectMeteringEvent(candidate.metering_event_id);
        projected += 1;
      } catch {
        failed += 1;
      }
    }

    return {
      processed: candidates.length,
      projected,
      failed
    };
  }

  async listProjectionBacklog(input?: { limit?: number }): Promise<EarningsProjectionBacklogItem[]> {
    const candidates = await this.listBacklogCandidates(input?.limit ?? DEFAULT_BACKLOG_LIMIT);
    const items: EarningsProjectionBacklogItem[] = [];

    for (const candidate of candidates) {
      const event = await this.deps.canonicalMeteringRepo.findById(candidate.metering_event_id);
      items.push({
        meteringEventId: candidate.metering_event_id,
        requestId: event?.request_id ?? null,
        contributorUserId: event?.capacity_owner_user_id ?? null,
        ownerOrgId: event?.serving_org_id ?? null,
        routingMode: event?.admission_routing_mode ?? null,
        contributorEarningsMinor: event?.contributor_earnings_minor ?? null,
        state: candidate.state,
        retryCount: candidate.retry_count,
        nextRetryAt: candidate.next_retry_at,
        updatedAt: candidate.updated_at
      });
    }

    return items;
  }

  private async listRetryCandidates(limit: number): Promise<MeteringProjectorStateRow[]> {
    const backlog = await this.listBacklogCandidates(limit);
    const now = this.now().getTime();
    return backlog.filter((row) => (
      row.state === 'pending_projection'
      || (row.next_retry_at !== null && new Date(row.next_retry_at).getTime() <= now)
    ));
  }

  private async listBacklogCandidates(limit: number): Promise<MeteringProjectorStateRow[]> {
    const pending = await this.deps.meteringProjectorStateRepo.listByProjectorAndState({
      projector: 'earnings',
      state: 'pending_projection'
    });
    const needsOperatorCorrection = await this.deps.meteringProjectorStateRepo.listByProjectorAndState({
      projector: 'earnings',
      state: 'needs_operator_correction'
    });
    return [...pending, ...needsOperatorCorrection.filter((row) => (
      row.state === 'needs_operator_correction'
    ))]
      .sort((left, right) => new Date(left.updated_at).getTime() - new Date(right.updated_at).getTime())
      .slice(0, Math.max(1, limit));
  }

  private async loadProjectorState(meteringEventId: string): Promise<MeteringProjectorStateRow | null> {
    const rows = await this.deps.meteringProjectorStateRepo.listByMeteringEventId(meteringEventId);
    return rows.find((row) => row.projector === 'earnings') ?? null;
  }

  private async requireMeteringEvent(meteringEventId: string): Promise<CanonicalMeteringEventRow> {
    const event = await this.deps.canonicalMeteringRepo.findById(meteringEventId);
    if (!event) {
      throw new Error(`canonical metering event not found: ${meteringEventId}`);
    }
    return event;
  }

  private assertProjectableEarningsEvent(event: CanonicalMeteringEventRow): void {
    if (event.contributor_earnings_minor === 0) {
      return;
    }

    if (event.admission_routing_mode !== 'team-overflow-on-contributor-capacity') {
      throw new Error('contributor earnings are only allowed for team-overflow-on-contributor-capacity');
    }

    if (!event.capacity_owner_user_id) {
      throw new Error('contributor earnings metering is missing capacity_owner_user_id');
    }
  }

  private buildLedgerEntry(
    event: CanonicalMeteringEventRow,
    draft: ReturnType<typeof buildEarningsProjectionEffects>[number]
  ): EarningsLedgerEntryInput {
    return {
      ownerOrgId: event.serving_org_id,
      contributorUserId: event.capacity_owner_user_id ?? '',
      meteringEventId: event.id,
      effectType: draft.effectType,
      balanceBucket: draft.effectType === 'contributor_accrual' ? 'withdrawable' : 'adjusted',
      amountMinor: draft.amountMinor,
      currency: event.currency,
      metadata: {
        requestId: event.request_id,
        attemptNo: event.attempt_no,
        routingMode: event.admission_routing_mode,
        provider: event.provider,
        model: event.model,
        rateCardVersionId: event.rate_card_version_id
      }
    };
  }

  private buildNextRetryAt(retryCount: number): Date | null {
    if (retryCount >= this.maxRetries) {
      return null;
    }

    const multiplier = Math.max(1, retryCount);
    return new Date(this.now().getTime() + BASE_RETRY_DELAY_MS * multiplier);
  }
}
