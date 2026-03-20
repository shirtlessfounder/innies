import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';
import type { FinalizationKind, RoutingMode } from '../types/phase2Contracts.js';

export type CanonicalMeteringEventInput = {
  finalizationKind: FinalizationKind;
  requestId: string;
  attemptNo: number;
  sessionId?: string | null;
  sourceMeteringEventId?: string | null;
  admissionOrgId: string;
  admissionCutoverId?: string | null;
  admissionRoutingMode: RoutingMode;
  consumerOrgId: string;
  consumerUserId?: string | null;
  teamConsumerId?: string | null;
  buyerKeyId?: string | null;
  servingOrgId: string;
  providerAccountId?: string | null;
  tokenCredentialId?: string | null;
  capacityOwnerUserId?: string | null;
  provider: string;
  model: string;
  rateCardVersionId: string;
  inputTokens: number;
  outputTokens: number;
  usageUnits: number;
  buyerDebitMinor: number;
  contributorEarningsMinor: number;
  currency?: string;
  metadata?: Record<string, unknown>;
};

export type CanonicalMeteringEventRow = {
  id: string;
  request_id: string;
  attempt_no: number;
  finalization_kind: FinalizationKind;
  idempotency_key: string;
  session_id: string | null;
  source_metering_event_id: string | null;
  admission_org_id: string;
  admission_cutover_id: string | null;
  admission_routing_mode: RoutingMode;
  consumer_org_id: string;
  consumer_user_id: string | null;
  team_consumer_id: string | null;
  buyer_key_id: string | null;
  serving_org_id: string;
  provider_account_id: string | null;
  token_credential_id: string | null;
  capacity_owner_user_id: string | null;
  provider: string;
  model: string;
  rate_card_version_id: string;
  input_tokens: number;
  output_tokens: number;
  usage_units: number;
  buyer_debit_minor: number;
  contributor_earnings_minor: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export class CanonicalMeteringRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  createServedRequest(
    input: Omit<CanonicalMeteringEventInput, 'finalizationKind'>
  ): Promise<CanonicalMeteringEventRow> {
    return this.insertEvent({
      ...input,
      finalizationKind: 'served_request'
    });
  }

  createCorrection(
    input: Omit<CanonicalMeteringEventInput, 'finalizationKind'>
  ): Promise<CanonicalMeteringEventRow> {
    return this.insertEvent({
      ...input,
      finalizationKind: 'correction'
    });
  }

  createReversal(
    input: Omit<CanonicalMeteringEventInput, 'finalizationKind'>
  ): Promise<CanonicalMeteringEventRow> {
    return this.insertEvent({
      ...input,
      finalizationKind: 'reversal'
    });
  }

  async insertEvent(input: CanonicalMeteringEventInput): Promise<CanonicalMeteringEventRow> {
    if (input.finalizationKind === 'served_request' && input.sourceMeteringEventId) {
      throw new Error('served_request rows cannot set sourceMeteringEventId');
    }

    if (input.finalizationKind !== 'served_request' && !input.sourceMeteringEventId) {
      throw new Error(`${input.finalizationKind} rows require sourceMeteringEventId`);
    }

    const sql = `
      insert into ${TABLES.canonicalMeteringEvents} (
        id,
        request_id,
        attempt_no,
        finalization_kind,
        idempotency_key,
        session_id,
        source_metering_event_id,
        admission_org_id,
        admission_cutover_id,
        admission_routing_mode,
        consumer_org_id,
        consumer_user_id,
        team_consumer_id,
        buyer_key_id,
        serving_org_id,
        provider_account_id,
        token_credential_id,
        capacity_owner_user_id,
        provider,
        model,
        rate_card_version_id,
        input_tokens,
        output_tokens,
        usage_units,
        buyer_debit_minor,
        contributor_earnings_minor,
        currency,
        metadata
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
      )
      on conflict (request_id, attempt_no, finalization_kind)
      do nothing
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.requestId,
      input.attemptNo,
      input.finalizationKind,
      buildMeteringIdempotencyKey(input.requestId, input.attemptNo, input.finalizationKind),
      input.sessionId ?? null,
      input.sourceMeteringEventId ?? null,
      input.admissionOrgId,
      input.admissionCutoverId ?? null,
      input.admissionRoutingMode,
      input.consumerOrgId,
      input.consumerUserId ?? null,
      input.teamConsumerId ?? null,
      input.buyerKeyId ?? null,
      input.servingOrgId,
      input.providerAccountId ?? null,
      input.tokenCredentialId ?? null,
      input.capacityOwnerUserId ?? null,
      input.provider,
      input.model,
      input.rateCardVersionId,
      input.inputTokens,
      input.outputTokens,
      input.usageUnits,
      input.buyerDebitMinor,
      input.contributorEarningsMinor,
      input.currency ?? 'USD',
      input.metadata ? JSON.stringify(input.metadata) : null
    ];

    const result = await this.db.query<CanonicalMeteringEventRow>(sql, params);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findExistingEvent(input);
    if (existing) {
      assertCanonicalMeteringReplayMatches(input, existing);
      return existing;
    }

    throw new Error('expected one canonical metering row');
  }

  private async findExistingEvent(input: Pick<CanonicalMeteringEventInput, 'requestId' | 'attemptNo' | 'finalizationKind'>): Promise<CanonicalMeteringEventRow | null> {
    const sql = `
      select *
      from ${TABLES.canonicalMeteringEvents}
      where request_id = $1
        and attempt_no = $2
        and finalization_kind = $3
      limit 1
    `;
    const result = await this.db.query<CanonicalMeteringEventRow>(sql, [
      input.requestId,
      input.attemptNo,
      input.finalizationKind
    ]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

export function buildMeteringIdempotencyKey(
  requestId: string,
  attemptNo: number,
  finalizationKind: FinalizationKind
): string {
  return `${requestId}:${attemptNo}:${finalizationKind}`;
}

function assertCanonicalMeteringReplayMatches(
  input: CanonicalMeteringEventInput,
  row: CanonicalMeteringEventRow
): void {
  assertIdempotentReplayMatches('canonical metering', [
    { field: 'requestId', expected: input.requestId, actual: row.request_id },
    { field: 'attemptNo', expected: input.attemptNo, actual: row.attempt_no },
    { field: 'finalizationKind', expected: input.finalizationKind, actual: row.finalization_kind },
    { field: 'sessionId', expected: input.sessionId ?? null, actual: row.session_id },
    { field: 'sourceMeteringEventId', expected: input.sourceMeteringEventId ?? null, actual: row.source_metering_event_id },
    { field: 'admissionOrgId', expected: input.admissionOrgId, actual: row.admission_org_id },
    { field: 'admissionCutoverId', expected: input.admissionCutoverId ?? null, actual: row.admission_cutover_id },
    { field: 'admissionRoutingMode', expected: input.admissionRoutingMode, actual: row.admission_routing_mode },
    { field: 'consumerOrgId', expected: input.consumerOrgId, actual: row.consumer_org_id },
    { field: 'consumerUserId', expected: input.consumerUserId ?? null, actual: row.consumer_user_id },
    { field: 'teamConsumerId', expected: input.teamConsumerId ?? null, actual: row.team_consumer_id },
    { field: 'buyerKeyId', expected: input.buyerKeyId ?? null, actual: row.buyer_key_id },
    { field: 'servingOrgId', expected: input.servingOrgId, actual: row.serving_org_id },
    { field: 'providerAccountId', expected: input.providerAccountId ?? null, actual: row.provider_account_id },
    { field: 'tokenCredentialId', expected: input.tokenCredentialId ?? null, actual: row.token_credential_id },
    { field: 'capacityOwnerUserId', expected: input.capacityOwnerUserId ?? null, actual: row.capacity_owner_user_id },
    { field: 'provider', expected: input.provider, actual: row.provider },
    { field: 'model', expected: input.model, actual: row.model },
    { field: 'rateCardVersionId', expected: input.rateCardVersionId, actual: row.rate_card_version_id },
    { field: 'inputTokens', expected: input.inputTokens, actual: row.input_tokens },
    { field: 'outputTokens', expected: input.outputTokens, actual: row.output_tokens },
    { field: 'usageUnits', expected: input.usageUnits, actual: row.usage_units },
    { field: 'buyerDebitMinor', expected: input.buyerDebitMinor, actual: row.buyer_debit_minor },
    { field: 'contributorEarningsMinor', expected: input.contributorEarningsMinor, actual: row.contributor_earnings_minor },
    { field: 'currency', expected: input.currency ?? 'USD', actual: row.currency },
    { field: 'metadata', expected: input.metadata ?? null, actual: row.metadata }
  ]);
}
