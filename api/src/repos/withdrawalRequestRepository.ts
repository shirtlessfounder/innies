import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import {
  canTransitionWithdrawalRequestStatus,
  type WithdrawalRequestStatus
} from '../types/phase2Contracts.js';

export type CreateWithdrawalRequestInput = {
  ownerOrgId: string;
  contributorUserId: string;
  amountMinor: number;
  currency?: string;
  destination: Record<string, unknown>;
  requestedByUserId: string;
  note?: string | null;
};

export type WithdrawalRequestRow = {
  id: string;
  owner_org_id: string;
  contributor_user_id: string;
  amount_minor: number;
  currency: string;
  destination: Record<string, unknown>;
  status: WithdrawalRequestStatus;
  requested_by_user_id: string;
  reviewed_by_user_id: string | null;
  reviewed_by_api_key_id: string | null;
  note: string | null;
  settlement_reference: string | null;
  settlement_failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export class WithdrawalRequestRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async create(input: CreateWithdrawalRequestInput): Promise<WithdrawalRequestRow> {
    const sql = `
      insert into ${TABLES.withdrawalRequests} (
        id,
        owner_org_id,
        contributor_user_id,
        amount_minor,
        currency,
        destination,
        status,
        requested_by_user_id,
        note,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()
      )
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.ownerOrgId,
      input.contributorUserId,
      input.amountMinor,
      input.currency ?? 'USD',
      JSON.stringify(input.destination),
      'requested',
      input.requestedByUserId,
      input.note ?? null
    ];

    return this.expectOne(sql, params);
  }

  async transitionStatus(input: {
    id: string;
    nextStatus: WithdrawalRequestStatus;
    actedByUserId: string | null;
    actedByApiKeyId?: string | null;
    settlementReference?: string | null;
    settlementFailureReason?: string | null;
  }): Promise<WithdrawalRequestRow> {
    const current = await this.findById(input.id);
    if (!current) {
      throw new Error(`withdrawal request not found: ${input.id}`);
    }

    if (!canTransitionWithdrawalRequestStatus(current.status, input.nextStatus)) {
      throw new Error(`illegal withdrawal request transition: ${current.status} -> ${input.nextStatus}`);
    }

    const sql = `
      update ${TABLES.withdrawalRequests}
      set
        status = $3,
        reviewed_by_user_id = $4,
        reviewed_by_api_key_id = $5,
        settlement_reference = coalesce($6, settlement_reference),
        settlement_failure_reason = $7,
        updated_at = now()
      where id = $1
        and status = $2
      returning *
    `;
    const params: SqlValue[] = [
      input.id,
      current.status,
      input.nextStatus,
      input.actedByUserId,
      input.actedByApiKeyId ?? null,
      input.settlementReference ?? null,
      input.settlementFailureReason ?? null
    ];
    const result = await this.db.query<WithdrawalRequestRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error(`withdrawal request transitioned concurrently: ${input.id}`);
    }

    return result.rows[0];
  }

  async findById(id: string): Promise<WithdrawalRequestRow | null> {
    const sql = `
      select *
      from ${TABLES.withdrawalRequests}
      where id = $1
      limit 1
    `;
    const result = await this.db.query<WithdrawalRequestRow>(sql, [id]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  listByContributorUserId(contributorUserId: string): Promise<WithdrawalRequestRow[]> {
    const sql = `
      select *
      from ${TABLES.withdrawalRequests}
      where contributor_user_id = $1
      order by created_at desc
    `;
    return this.db.query<WithdrawalRequestRow>(sql, [contributorUserId]).then((result) => result.rows);
  }

  listByOwnerOrgAndContributorUserId(input: {
    ownerOrgId: string;
    contributorUserId: string;
  }): Promise<WithdrawalRequestRow[]> {
    const sql = `
      select *
      from ${TABLES.withdrawalRequests}
      where owner_org_id = $1
        and contributor_user_id = $2
      order by created_at desc
    `;
    return this.db.query<WithdrawalRequestRow>(sql, [input.ownerOrgId, input.contributorUserId]).then((result) => result.rows);
  }

  listByOwnerOrgId(ownerOrgId: string): Promise<WithdrawalRequestRow[]> {
    const sql = `
      select *
      from ${TABLES.withdrawalRequests}
      where owner_org_id = $1
      order by created_at desc
    `;
    return this.db.query<WithdrawalRequestRow>(sql, [ownerOrgId]).then((result) => result.rows);
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<WithdrawalRequestRow> {
    const result = await this.db.query<WithdrawalRequestRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one withdrawal request row');
    }
    return result.rows[0];
  }
}
