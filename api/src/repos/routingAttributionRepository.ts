import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type RequestHistoryCursor = {
  createdAt: string;
  requestId: string;
  attemptNo: number;
};

export type RequestHistoryRow = {
  request_id: string;
  attempt_no: number;
  session_id: string | null;
  admission_org_id: string;
  admission_cutover_id: string | null;
  admission_routing_mode: string;
  consumer_org_id: string;
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
  prompt_preview: string | null;
  response_preview: string | null;
  route_decision: Record<string, unknown> | null;
  projector_states: Array<{
    projector: string;
    state: string;
    retryCount: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> | null;
};

export type FinanciallyUnfinalizedRequestRow = {
  request_id: string;
  attempt_no: number;
  org_id: string;
  provider: string;
  model: string;
  upstream_status: number | null;
  created_at: string;
  route_decision: Record<string, unknown> | null;
};

export class RoutingAttributionRepository {
  constructor(private readonly db: SqlClient) {}

  async listOrgRequestHistory(input: {
    orgId: string;
    limit: number;
    cursor?: RequestHistoryCursor | null;
    historyScope?: 'post_cutover' | 'all';
  }): Promise<RequestHistoryRow[]> {
    return this.listHistory({
      orgId: input.orgId,
      limit: input.limit,
      cursor: input.cursor,
      historyScope: input.historyScope ?? 'post_cutover',
      admin: false
    });
  }

  async listAdminRequestHistory(input: {
    consumerOrgId?: string;
    limit: number;
    cursor?: RequestHistoryCursor | null;
    historyScope?: 'post_cutover' | 'all';
  }): Promise<RequestHistoryRow[]> {
    return this.listHistory({
      orgId: input.consumerOrgId ?? null,
      limit: input.limit,
      cursor: input.cursor,
      historyScope: input.historyScope ?? 'all',
      admin: true
    });
  }

  async getRequestExplanation(requestId: string): Promise<RequestHistoryRow | null> {
    const params: SqlValue[] = [requestId];
    const result = await this.db.query<RequestHistoryRow>(`${historySelectSql()}
      where cm.finalization_kind = 'served_request'
        and cm.request_id = $1
      order by cm.attempt_no desc
      limit 1
    `, params);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async listFinanciallyUnfinalizedRequests(limit = 50): Promise<FinanciallyUnfinalizedRequestRow[]> {
    const sql = `
      select
        re.request_id,
        re.attempt_no,
        re.org_id,
        re.provider,
        re.model,
        re.upstream_status,
        re.created_at,
        re.route_decision
      from ${TABLES.routingEvents} re
      left join ${TABLES.canonicalMeteringEvents} cm
        on cm.request_id = re.request_id
       and cm.attempt_no = re.attempt_no
       and cm.finalization_kind = 'served_request'
      where re.upstream_status is not null
        and re.upstream_status >= 200
        and re.upstream_status < 300
        and cm.id is null
      order by re.created_at desc
      limit $1
    `;
    const result = await this.db.query<FinanciallyUnfinalizedRequestRow>(sql, [Math.max(1, Math.min(200, Math.floor(limit)))]);
    return result.rows.map((row) => ({
      ...row,
      route_decision: normalizeJson(row.route_decision)
    }));
  }

  private async listHistory(input: {
    orgId: string | null;
    limit: number;
    cursor?: RequestHistoryCursor | null;
    historyScope: 'post_cutover' | 'all';
    admin: boolean;
  }): Promise<RequestHistoryRow[]> {
    const params: SqlValue[] = [];
    const where: string[] = [];

    if (input.orgId) {
      params.push(input.orgId);
      where.push(`cm.consumer_org_id = $${params.length}`);
    }

    if (input.historyScope === 'post_cutover') {
      where.push('cm.admission_cutover_id is not null');
    }

    if (input.cursor) {
      params.push(input.cursor.createdAt);
      const createdAtParam = params.length;
      params.push(input.cursor.requestId);
      const requestIdParam = params.length;
      params.push(input.cursor.attemptNo);
      const attemptNoParam = params.length;
      where.push(`(
        cm.created_at < $${createdAtParam}
        or (cm.created_at = $${createdAtParam} and cm.request_id < $${requestIdParam})
        or (cm.created_at = $${createdAtParam} and cm.request_id = $${requestIdParam} and cm.attempt_no < $${attemptNoParam})
      )`);
    }

    params.push(Math.max(1, Math.min(100, Math.floor(input.limit))));
    const sql = `${historySelectSql()}
      where cm.finalization_kind = 'served_request'
      ${where.length > 0 ? `and ${where.join(' and ')}` : ''}
      order by cm.created_at desc, cm.request_id desc, cm.attempt_no desc
      limit $${params.length}
    `;
    const result = await this.db.query<RequestHistoryRow>(sql, params);
    return result.rows.map(mapHistoryRow);
  }
}

function historySelectSql(): string {
  return `
    select
      cm.request_id,
      cm.attempt_no,
      cm.session_id,
      cm.admission_org_id,
      cm.admission_cutover_id,
      cm.admission_routing_mode,
      cm.consumer_org_id,
      cm.buyer_key_id,
      cm.serving_org_id,
      cm.provider_account_id,
      cm.token_credential_id,
      cm.capacity_owner_user_id,
      cm.provider,
      cm.model,
      cm.rate_card_version_id,
      cm.input_tokens,
      cm.output_tokens,
      cm.usage_units,
      cm.buyer_debit_minor,
      cm.contributor_earnings_minor,
      cm.currency,
      cm.metadata,
      cm.created_at,
      rl.prompt_preview,
      rl.response_preview,
      re.route_decision,
      (
        select json_agg(json_build_object(
          'projector', mps.projector,
          'state', mps.state,
          'retryCount', mps.retry_count,
          'lastErrorCode', mps.last_error_code,
          'lastErrorMessage', mps.last_error_message
        ) order by mps.projector asc)
        from ${TABLES.meteringProjectorStates} mps
        where mps.metering_event_id = cm.id
      ) as projector_states
    from ${TABLES.canonicalMeteringEvents} cm
    left join ${TABLES.requestLog} rl
      on rl.org_id = cm.consumer_org_id
     and rl.request_id = cm.request_id
     and rl.attempt_no = cm.attempt_no
    left join ${TABLES.routingEvents} re
      on re.org_id = cm.consumer_org_id
     and re.request_id = cm.request_id
     and re.attempt_no = cm.attempt_no
  `;
}

function mapHistoryRow(row: RequestHistoryRow): RequestHistoryRow {
  return {
    ...row,
    metadata: normalizeJson(row.metadata),
    route_decision: normalizeJson(row.route_decision),
    projector_states: normalizeProjectorStates(row.projector_states)
  };
}

function normalizeProjectorStates(value: unknown): RequestHistoryRow['projector_states'] {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      projector: String(record.projector ?? ''),
      state: String(record.state ?? ''),
      retryCount: Number(record.retryCount ?? 0),
      lastErrorCode: record.lastErrorCode == null ? null : String(record.lastErrorCode),
      lastErrorMessage: record.lastErrorMessage == null ? null : String(record.lastErrorMessage)
    };
  });
}

function normalizeJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}
