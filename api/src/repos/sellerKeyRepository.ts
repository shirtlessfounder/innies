import type { SqlClient, SqlValue } from './sqlClient.js';
import type { SellerKey, SellerKeyStatus } from '../types/routing.js';
import { newId } from '../utils/ids.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';

export type CreateSellerKeyInput = {
  orgId: string;
  provider: string;
  providerAccountLabel?: string;
  secret: string;
  encryptionKeyId: string;
  monthlyCapacityLimitUnits?: number;
  priorityWeight?: number;
  createdBy?: string;
};

export type UpdateSellerKeyInput = {
  status?: SellerKeyStatus;
  monthlyCapacityLimitUnits?: number | null;
  priorityWeight?: number;
};

type SellerKeyRow = {
  id: string;
  org_id: string;
  provider: string;
  status: SellerKeyStatus;
  priority_weight: number;
  monthly_capacity_limit_units: number | null;
  monthly_capacity_used_units: number;
};

export type SellerKeySecret = {
  id: string;
  secret: string;
};

export type SellerKeyHealthCandidate = {
  id: string;
  provider: string;
  failure_count: number;
};

export class SellerKeyRepository {
  constructor(private readonly db: SqlClient) {}

  async create(input: CreateSellerKeyInput): Promise<{ id: string }> {
    const id = newId();
    const sql = `
      insert into in_seller_keys (
        id,
        org_id,
        provider,
        provider_account_label,
        encrypted_secret,
        encryption_key_id,
        status,
        monthly_capacity_limit_units,
        priority_weight,
        created_by,
        created_at,
        updated_at
      ) values ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,now(),now())
    `;

    const params: SqlValue[] = [
      id,
      input.orgId,
      input.provider,
      input.providerAccountLabel ?? null,
      encryptSecret(input.secret),
      input.encryptionKeyId,
      input.monthlyCapacityLimitUnits ?? null,
      input.priorityWeight ?? 100,
      input.createdBy ?? null
    ];

    await this.db.query(sql, params);
    return { id };
  }

  async update(id: string, input: UpdateSellerKeyInput): Promise<boolean> {
    const sets: string[] = [];
    const params: SqlValue[] = [];

    if (input.status) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }

    if (input.monthlyCapacityLimitUnits !== undefined) {
      params.push(input.monthlyCapacityLimitUnits);
      sets.push(`monthly_capacity_limit_units = $${params.length}`);
    }

    if (input.priorityWeight !== undefined) {
      params.push(input.priorityWeight);
      sets.push(`priority_weight = $${params.length}`);
    }

    if (sets.length === 0) return true;

    params.push(id);
    const sql = `
      update in_seller_keys
      set ${sets.join(', ')}, updated_at = now()
      where id = $${params.length}
    `;

    const result = await this.db.query(sql, params);
    return result.rowCount === 1;
  }

  async listActiveForRouting(provider: string, model: string, streaming: boolean): Promise<SellerKey[]> {
    const sql = `
      select
        sk.id,
        sk.org_id,
        sk.provider,
        sk.status,
        sk.priority_weight,
        sk.monthly_capacity_limit_units,
        sk.monthly_capacity_used_units
      from in_seller_keys sk
      where sk.provider = $1
        and sk.status = 'active'
        and (sk.monthly_capacity_limit_units is null or sk.monthly_capacity_used_units < sk.monthly_capacity_limit_units)
        and not exists (
          select 1 from in_kill_switch_current k
          where k.scope = 'seller_key' and k.target_id = sk.id::text and k.is_disabled = true
        )
        and exists (
          select 1
          from in_model_compatibility_rules m
          where m.provider = $1
            and m.model = $2
            and m.is_enabled = true
            and m.effective_from <= now()
            and (m.effective_to is null or m.effective_to > now())
            and ($3::boolean = false or m.supports_streaming = true)
        )
    `;

    const rows = await this.db.query<SellerKeyRow>(sql, [provider, model, streaming]);
    return rows.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      provider: row.provider,
      model,
      status: row.status,
      priorityWeight: row.priority_weight,
      monthlyCapacityLimitUnits: row.monthly_capacity_limit_units ?? undefined,
      monthlyCapacityUsedUnits: row.monthly_capacity_used_units,
      supportsStreaming: true
    }));
  }

  async getSecret(id: string): Promise<SellerKeySecret | null> {
    const sql = `select id, encrypted_secret from in_seller_keys where id = $1 limit 1`;
    const result = await this.db.query<{ id: string; encrypted_secret: Buffer | string }>(sql, [id]);
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    const secret = decryptSecret(row.encrypted_secret);

    return { id: row.id, secret };
  }

  async addCapacityUsage(id: string, usageUnits: number): Promise<void> {
    const sql = `
      update in_seller_keys
      set monthly_capacity_used_units = monthly_capacity_used_units + $2,
          last_used_at = now(),
          updated_at = now()
      where id = $1
    `;
    await this.db.query(sql, [id, usageUnits]);
  }

  async statusCounts(): Promise<Record<SellerKeyStatus, number>> {
    const sql = `
      select status, count(*)::int as count
      from in_seller_keys
      group by status
    `;

    const result = await this.db.query<{ status: SellerKeyStatus; count: number }>(sql);
    const baseline: Record<SellerKeyStatus, number> = {
      active: 0,
      paused: 0,
      quarantined: 0,
      invalid: 0,
      revoked: 0
    };

    for (const row of result.rows) baseline[row.status] = row.count;
    return baseline;
  }

  async listHealthCheckCandidates(limit: number): Promise<SellerKeyHealthCandidate[]> {
    const sql = `
      select id, provider, failure_count
      from in_seller_keys
      where status = 'active'
      order by coalesce(last_health_at, to_timestamp(0)) asc
      limit $1
    `;
    const result = await this.db.query<SellerKeyHealthCandidate>(sql, [limit]);
    return result.rows;
  }

  async markHealthCheckSuccess(id: string): Promise<void> {
    const sql = `
      update in_seller_keys
      set failure_count = 0,
          last_health_at = now(),
          updated_at = now()
      where id = $1
    `;
    await this.db.query(sql, [id]);
  }

  async markHealthCheckFailure(id: string, quarantineThreshold: number): Promise<{ status: SellerKeyStatus; failureCount: number } | null> {
    const sql = `
      update in_seller_keys
      set failure_count = failure_count + 1,
          status = case
            when (failure_count + 1) >= $2 then 'quarantined'::in_seller_key_status
            else status
          end,
          last_health_at = now(),
          updated_at = now()
      where id = $1
        and status = 'active'
      returning status, failure_count
    `;

    const result = await this.db.query<{ status: SellerKeyStatus; failure_count: number }>(sql, [id, quarantineThreshold]);
    if (result.rowCount !== 1) return null;
    return {
      status: result.rows[0].status,
      failureCount: result.rows[0].failure_count
    };
  }
}
