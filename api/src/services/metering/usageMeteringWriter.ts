import {
  UsageLedgerRepository,
  type UsageLedgerRow,
  type UsageLedgerWriteInput
} from '../../repos/usageLedgerRepository.js';
import {
  CanonicalMeteringRepository,
  type CanonicalMeteringEventRow
} from '../../repos/canonicalMeteringRepository.js';
import { MeteringProjectorStateRepository } from '../../repos/meteringProjectorStateRepository.js';
import { FnfOwnershipRepository } from '../../repos/fnfOwnershipRepository.js';
import { RateCardRepository } from '../../repos/rateCardRepository.js';
import type { RoutingMode } from '../../types/phase2Contracts.js';

export type MeteringEvent = Omit<UsageLedgerWriteInput, 'entryType' | 'sourceEventId'> & {
  sessionId?: string | null;
  admissionOrgId?: string;
  admissionCutoverId?: string | null;
  admissionRoutingMode?: RoutingMode;
  consumerUserId?: string | null;
  teamConsumerId?: string | null;
  servingOrgId?: string;
  providerAccountId?: string | null;
  tokenCredentialId?: string | null;
  capacityOwnerUserId?: string | null;
  rateCardVersionId?: string | null;
  buyerDebitMinor?: number | null;
  contributorEarningsMinor?: number | null;
  metadata?: Record<string, unknown>;
};

type CanonicalEventContext = {
  sessionId: string | null;
  admissionOrgId: string;
  admissionCutoverId: string | null;
  admissionRoutingMode: RoutingMode;
  consumerUserId: string | null;
  teamConsumerId: string | null;
  servingOrgId: string;
  providerAccountId: string | null;
  tokenCredentialId: string | null;
  capacityOwnerUserId: string | null;
  rateCardVersionId: string;
  buyerDebitMinor: number;
  contributorEarningsMinor: number;
  metadata: Record<string, unknown> | undefined;
};

export class UsageMeteringWriter {
  constructor(private readonly deps: {
    usageLedgerRepo: UsageLedgerRepository;
    canonicalMeteringRepo?: CanonicalMeteringRepository;
    meteringProjectorStateRepo?: MeteringProjectorStateRepository;
    rateCardRepo?: RateCardRepository;
    ownershipRepo?: FnfOwnershipRepository;
  }) {}

  async recordUsage(event: MeteringEvent): Promise<UsageLedgerRow> {
    const row = await this.deps.usageLedgerRepo.createUsageRow({
      ...event,
      entryType: 'usage'
    });
    const canonical = await this.resolveCanonicalContext(event);
    if (!canonical || !this.deps.canonicalMeteringRepo) {
      return row;
    }

    const saved = await this.deps.canonicalMeteringRepo.createServedRequest({
      requestId: event.requestId,
      attemptNo: event.attemptNo,
      sessionId: canonical.sessionId,
      admissionOrgId: canonical.admissionOrgId,
      admissionCutoverId: canonical.admissionCutoverId,
      admissionRoutingMode: canonical.admissionRoutingMode,
      consumerOrgId: event.orgId,
      consumerUserId: canonical.consumerUserId,
      teamConsumerId: canonical.teamConsumerId,
      buyerKeyId: event.apiKeyId ?? null,
      servingOrgId: canonical.servingOrgId,
      providerAccountId: canonical.providerAccountId,
      tokenCredentialId: canonical.tokenCredentialId,
      capacityOwnerUserId: canonical.capacityOwnerUserId,
      provider: event.provider,
      model: event.model,
      rateCardVersionId: canonical.rateCardVersionId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      usageUnits: event.usageUnits,
      buyerDebitMinor: canonical.buyerDebitMinor,
      contributorEarningsMinor: canonical.contributorEarningsMinor,
      currency: event.currency ?? 'USD',
      metadata: canonical.metadata
    });
    await this.ensureProjectionStates(saved, canonical);
    return row;
  }

  async recordCorrection(sourceEventId: string, event: MeteringEvent, note: string): Promise<UsageLedgerRow> {
    const row = await this.deps.usageLedgerRepo.createCorrectionRow({
      ...event,
      entryType: 'correction',
      sourceEventId,
      note
    });
    const canonical = await this.resolveCanonicalContext(event);
    if (!canonical || !this.deps.canonicalMeteringRepo) {
      return row;
    }

    const saved = await this.deps.canonicalMeteringRepo.createCorrection({
      requestId: event.requestId,
      attemptNo: event.attemptNo,
      sessionId: canonical.sessionId,
      sourceMeteringEventId: sourceEventId,
      admissionOrgId: canonical.admissionOrgId,
      admissionCutoverId: canonical.admissionCutoverId,
      admissionRoutingMode: canonical.admissionRoutingMode,
      consumerOrgId: event.orgId,
      consumerUserId: canonical.consumerUserId,
      teamConsumerId: canonical.teamConsumerId,
      buyerKeyId: event.apiKeyId ?? null,
      servingOrgId: canonical.servingOrgId,
      providerAccountId: canonical.providerAccountId,
      tokenCredentialId: canonical.tokenCredentialId,
      capacityOwnerUserId: canonical.capacityOwnerUserId,
      provider: event.provider,
      model: event.model,
      rateCardVersionId: canonical.rateCardVersionId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      usageUnits: event.usageUnits,
      buyerDebitMinor: canonical.buyerDebitMinor,
      contributorEarningsMinor: canonical.contributorEarningsMinor,
      currency: event.currency ?? 'USD',
      metadata: {
        ...canonical.metadata,
        note
      }
    });
    await this.ensureProjectionStates(saved, canonical);
    return row;
  }

  async recordReversal(sourceEventId: string, event: MeteringEvent, note: string): Promise<UsageLedgerRow> {
    const row = await this.deps.usageLedgerRepo.createReversalRow({
      ...event,
      entryType: 'reversal',
      sourceEventId,
      note
    });
    const canonical = await this.resolveCanonicalContext(event);
    if (!canonical || !this.deps.canonicalMeteringRepo) {
      return row;
    }

    const saved = await this.deps.canonicalMeteringRepo.createReversal({
      requestId: event.requestId,
      attemptNo: event.attemptNo,
      sessionId: canonical.sessionId,
      sourceMeteringEventId: sourceEventId,
      admissionOrgId: canonical.admissionOrgId,
      admissionCutoverId: canonical.admissionCutoverId,
      admissionRoutingMode: canonical.admissionRoutingMode,
      consumerOrgId: event.orgId,
      consumerUserId: canonical.consumerUserId,
      teamConsumerId: canonical.teamConsumerId,
      buyerKeyId: event.apiKeyId ?? null,
      servingOrgId: canonical.servingOrgId,
      providerAccountId: canonical.providerAccountId,
      tokenCredentialId: canonical.tokenCredentialId,
      capacityOwnerUserId: canonical.capacityOwnerUserId,
      provider: event.provider,
      model: event.model,
      rateCardVersionId: canonical.rateCardVersionId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      usageUnits: event.usageUnits,
      buyerDebitMinor: canonical.buyerDebitMinor * -1,
      contributorEarningsMinor: canonical.contributorEarningsMinor * -1,
      currency: event.currency ?? 'USD',
      metadata: {
        ...canonical.metadata,
        note
      }
    });
    await this.ensureProjectionStates(saved, {
      ...canonical,
      buyerDebitMinor: canonical.buyerDebitMinor * -1,
      contributorEarningsMinor: canonical.contributorEarningsMinor * -1
    });
    return row;
  }

  private async resolveCanonicalContext(event: MeteringEvent): Promise<CanonicalEventContext | null> {
    const ownership = event.tokenCredentialId && this.deps.ownershipRepo
      ? await this.deps.ownershipRepo.findTokenCredentialOwnership(event.tokenCredentialId)
      : null;
    const buyerOwnership = event.apiKeyId && this.deps.ownershipRepo
      ? await this.deps.ownershipRepo.findBuyerKeyOwnership(event.apiKeyId)
      : null;

    const routingMode = event.admissionRoutingMode
      ?? inferRoutingMode({
          event,
          ownership,
          buyerOwnership
        });
    if (!routingMode) {
      return null;
    }

    const appliedRate = event.rateCardVersionId
      ? null
      : await this.deps.rateCardRepo?.resolveAppliedRate({
          provider: event.provider,
          model: event.model,
          routingMode
        });
    const rateCardVersionId = event.rateCardVersionId ?? appliedRate?.rateCardVersionId ?? null;
    if (!rateCardVersionId) {
      return null;
    }

    const buyerDebitMinor = normalizeMinorAmount(
      event.buyerDebitMinor,
      appliedRate ? appliedRate.buyerDebitMinorPerUnit * event.usageUnits : 0
    );
    const contributorEarningsMinor = normalizeMinorAmount(
      event.contributorEarningsMinor,
      appliedRate ? appliedRate.contributorEarningsMinorPerUnit * event.usageUnits : 0
    );

    return {
      sessionId: event.sessionId ?? null,
      admissionOrgId: event.admissionOrgId ?? event.orgId,
      admissionCutoverId: event.admissionCutoverId ?? null,
      admissionRoutingMode: routingMode,
      consumerUserId: event.consumerUserId ?? null,
      teamConsumerId: event.teamConsumerId ?? (routingMode === 'team-overflow-on-contributor-capacity' ? 'innies-team' : null),
      servingOrgId: event.servingOrgId ?? ownership?.owner_org_id ?? event.orgId,
      providerAccountId: event.providerAccountId ?? event.tokenCredentialId ?? event.sellerKeyId ?? null,
      tokenCredentialId: event.tokenCredentialId ?? null,
      capacityOwnerUserId: event.capacityOwnerUserId ?? ownership?.capacity_owner_user_id ?? null,
      rateCardVersionId,
      buyerDebitMinor,
      contributorEarningsMinor,
      metadata: event.metadata
    };
  }

  private async ensureProjectionStates(
    saved: CanonicalMeteringEventRow,
    canonical: CanonicalEventContext
  ): Promise<void> {
    if (!this.deps.meteringProjectorStateRepo) {
      return;
    }

    if (canonical.buyerDebitMinor !== 0) {
      await this.deps.meteringProjectorStateRepo.ensurePending({
        meteringEventId: saved.id,
        projector: 'wallet'
      });
    }
    if (canonical.contributorEarningsMinor !== 0) {
      await this.deps.meteringProjectorStateRepo.ensurePending({
        meteringEventId: saved.id,
        projector: 'earnings'
      });
    }
  }
}

function inferRoutingMode(input: {
  event: MeteringEvent;
  ownership: Awaited<ReturnType<FnfOwnershipRepository['findTokenCredentialOwnership']>> | null;
  buyerOwnership: Awaited<ReturnType<FnfOwnershipRepository['findBuyerKeyOwnership']>> | null;
}): RoutingMode | null {
  const { event, ownership, buyerOwnership } = input;
  if (event.tokenCredentialId && ownership?.owner_org_id === event.orgId) {
    return 'self-free';
  }
  if (event.capacityOwnerUserId && event.teamConsumerId) {
    return 'team-overflow-on-contributor-capacity';
  }
  if (event.sellerKeyId && buyerOwnership?.owner_org_id === event.orgId) {
    return 'paid-team-capacity';
  }
  return null;
}

function normalizeMinorAmount(value: number | null | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return Math.trunc(fallback);
}
