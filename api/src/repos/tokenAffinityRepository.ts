import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { TABLES } from './tableNames.js';

type TokenAffinityAssignmentRow = {
  org_id: string;
  provider: string;
  credential_id: string;
  session_id: string;
  last_activity_at: string | Date;
  grace_expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type TokenAffinityActiveStreamRow = {
  request_id: string;
  org_id: string;
  provider: string;
  credential_id: string;
  session_id: string;
  started_at: string | Date;
  last_touched_at: string | Date;
  ended_at: string | Date | null;
};

type CredentialIdRow = {
  credential_id: string;
};

export type TokenAffinityAssignment = {
  orgId: string;
  provider: string;
  credentialId: string;
  sessionId: string;
  lastActivityAt: Date;
  graceExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TokenAffinityActiveStream = {
  requestId: string;
  orgId: string;
  provider: string;
  credentialId: string;
  sessionId: string;
  startedAt: Date;
  lastTouchedAt: Date;
  endedAt: Date | null;
};

export type GetPreferredAssignmentInput = {
  orgId: string;
  provider: string;
  sessionId: string;
};

export type ClaimPreferredAssignmentInput = GetPreferredAssignmentInput & {
  credentialId: string;
};

export type ClaimPreferredAssignmentResult =
  | { outcome: 'claimed'; assignment: TokenAffinityAssignment }
  | { outcome: 'already_owned_by_session'; assignment: TokenAffinityAssignment }
  | { outcome: 'credential_unavailable' }
  | { outcome: 'session_already_bound'; assignment: TokenAffinityAssignment };

export type ClearPreferredAssignmentInput = GetPreferredAssignmentInput & {
  credentialId?: string;
};

export type TouchPreferredAssignmentInput = GetPreferredAssignmentInput & {
  credentialId: string;
  graceExpiresAt: Date | null;
};

export type UpsertActiveStreamInput = {
  requestId: string;
  orgId: string;
  provider: string;
  credentialId: string;
  sessionId: string;
};

export type TouchActiveStreamInput = {
  requestId: string;
  touchedAt: Date;
};

export type ClearActiveStreamInput = {
  requestId: string;
};

export type ListBusyCredentialIdsInput = {
  orgId: string;
  provider: string;
  staleBefore: Date;
};

export type ClearStaleActiveStreamsInput = {
  staleBefore: Date;
};

function mapAssignmentRow(row: TokenAffinityAssignmentRow): TokenAffinityAssignment {
  return {
    orgId: row.org_id,
    provider: row.provider,
    credentialId: row.credential_id,
    sessionId: row.session_id,
    lastActivityAt: new Date(row.last_activity_at),
    graceExpiresAt: row.grace_expires_at ? new Date(row.grace_expires_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function mapActiveStreamRow(row: TokenAffinityActiveStreamRow): TokenAffinityActiveStream {
  return {
    requestId: row.request_id,
    orgId: row.org_id,
    provider: row.provider,
    credentialId: row.credential_id,
    sessionId: row.session_id,
    startedAt: new Date(row.started_at),
    lastTouchedAt: new Date(row.last_touched_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null
  };
}

async function selectActiveStreamByRequestId(
  db: Pick<SqlClient, 'query'> | TransactionContext,
  requestId: string
): Promise<TokenAffinityActiveStream | null> {
  const result = await db.query<TokenAffinityActiveStreamRow>(
    `
      select
        request_id,
        org_id,
        provider,
        credential_id,
        session_id,
        started_at,
        last_touched_at,
        ended_at
      from ${TABLES.tokenAffinityActiveStreams}
      where request_id = $1
      limit 1
    `,
    [requestId]
  );

  return result.rowCount === 1 ? mapActiveStreamRow(result.rows[0]) : null;
}

async function selectAssignmentBySession(
  tx: TransactionContext,
  input: GetPreferredAssignmentInput
): Promise<TokenAffinityAssignment | null> {
  const result = await tx.query<TokenAffinityAssignmentRow>(
    `
      select
        org_id,
        provider,
        credential_id,
        session_id,
        last_activity_at,
        grace_expires_at,
        created_at,
        updated_at
      from ${TABLES.tokenAffinityAssignments}
      where org_id = $1::uuid and provider = $2 and session_id = $3
      limit 1
    `,
    [input.orgId, input.provider, input.sessionId]
  );

  return result.rowCount === 1 ? mapAssignmentRow(result.rows[0]) : null;
}

async function selectAssignmentByCredential(
  tx: TransactionContext,
  input: { orgId: string; provider: string; credentialId: string }
): Promise<TokenAffinityAssignment | null> {
  const result = await tx.query<TokenAffinityAssignmentRow>(
    `
      select
        org_id,
        provider,
        credential_id,
        session_id,
        last_activity_at,
        grace_expires_at,
        created_at,
        updated_at
      from ${TABLES.tokenAffinityAssignments}
      where org_id = $1::uuid and provider = $2 and credential_id = $3::uuid
      limit 1
    `,
    [input.orgId, input.provider, input.credentialId]
  );

  return result.rowCount === 1 ? mapAssignmentRow(result.rows[0]) : null;
}

export class TokenAffinityRepository {
  constructor(private readonly db: SqlClient) {}

  async getPreferredAssignment(input: GetPreferredAssignmentInput): Promise<TokenAffinityAssignment | null> {
    return selectAssignmentBySession(this.db, input);
  }

  async claimPreferredAssignment(input: ClaimPreferredAssignmentInput): Promise<ClaimPreferredAssignmentResult> {
    return this.db.transaction(async (tx) => {
      const existingBySession = await selectAssignmentBySession(tx, input);
      if (existingBySession) {
        return existingBySession.credentialId === input.credentialId
          ? { outcome: 'already_owned_by_session', assignment: existingBySession }
          : { outcome: 'session_already_bound', assignment: existingBySession };
      }

      const params: SqlValue[] = [
        input.orgId,
        input.provider,
        input.credentialId,
        input.sessionId
      ];

      const inserted = await tx.query<TokenAffinityAssignmentRow>(
        `
          insert into ${TABLES.tokenAffinityAssignments} (
            org_id,
            provider,
            credential_id,
            session_id,
            last_activity_at,
            grace_expires_at,
            created_at,
            updated_at
          ) values ($1::uuid, $2, $3::uuid, $4, now(), null, now(), now())
          on conflict do nothing
          returning
            org_id,
            provider,
            credential_id,
            session_id,
            last_activity_at,
            grace_expires_at,
            created_at,
            updated_at
        `,
        params
      );

      if (inserted.rowCount === 1) {
        return { outcome: 'claimed', assignment: mapAssignmentRow(inserted.rows[0]) };
      }

      const reboundBySession = await selectAssignmentBySession(tx, input);
      if (reboundBySession) {
        return reboundBySession.credentialId === input.credentialId
          ? { outcome: 'already_owned_by_session', assignment: reboundBySession }
          : { outcome: 'session_already_bound', assignment: reboundBySession };
      }

      const reboundByCredential = await selectAssignmentByCredential(tx, input);
      if (reboundByCredential && reboundByCredential.sessionId === input.sessionId) {
        return { outcome: 'already_owned_by_session', assignment: reboundByCredential };
      }

      return { outcome: 'credential_unavailable' };
    });
  }

  async clearPreferredAssignment(input: ClearPreferredAssignmentInput): Promise<boolean> {
    const params: SqlValue[] = [input.orgId, input.provider, input.sessionId];
    const where = [
      'org_id = $1::uuid',
      'provider = $2',
      'session_id = $3'
    ];

    if (input.credentialId) {
      params.push(input.credentialId);
      where.push(`credential_id = $${params.length}::uuid`);
    }

    const result = await this.db.query(
      `
        delete from ${TABLES.tokenAffinityAssignments}
        where ${where.join(' and ')}
      `,
      params
    );

    return result.rowCount > 0;
  }

  async touchPreferredAssignment(input: TouchPreferredAssignmentInput): Promise<boolean> {
    const params: SqlValue[] = [
      input.orgId,
      input.provider,
      input.sessionId,
      input.credentialId,
      input.graceExpiresAt
    ];

    const result = await this.db.query(
      `
        update ${TABLES.tokenAffinityAssignments}
        set
          last_activity_at = now(),
          grace_expires_at = $5,
          updated_at = now()
        where org_id = $1::uuid and provider = $2 and session_id = $3 and credential_id = $4::uuid
      `,
      params
    );

    return result.rowCount > 0;
  }

  async upsertActiveStream(input: UpsertActiveStreamInput): Promise<TokenAffinityActiveStream> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<TokenAffinityActiveStreamRow>(
        `
          insert into ${TABLES.tokenAffinityActiveStreams} (
            request_id,
            org_id,
            provider,
            credential_id,
            session_id,
            started_at,
            last_touched_at,
            ended_at
          ) values ($1, $2::uuid, $3, $4::uuid, $5, now(), now(), null)
          on conflict (request_id)
          do update set
            last_touched_at = excluded.last_touched_at,
            ended_at = null
          where
            ${TABLES.tokenAffinityActiveStreams}.org_id = excluded.org_id
            and ${TABLES.tokenAffinityActiveStreams}.provider = excluded.provider
            and ${TABLES.tokenAffinityActiveStreams}.credential_id = excluded.credential_id
            and ${TABLES.tokenAffinityActiveStreams}.session_id = excluded.session_id
          returning
            request_id,
            org_id,
            provider,
            credential_id,
            session_id,
            started_at,
            last_touched_at,
            ended_at
        `,
        [
          input.requestId,
          input.orgId,
          input.provider,
          input.credentialId,
          input.sessionId
        ]
      );

      if (result.rowCount === 1) {
        return mapActiveStreamRow(result.rows[0]);
      }

      const existing = await selectActiveStreamByRequestId(tx, input.requestId);
      if (existing) {
        return existing;
      }

      throw new Error('expected active stream upsert');
    });
  }

  async touchActiveStream(input: TouchActiveStreamInput): Promise<boolean> {
    const result = await this.db.query(
      `
        update ${TABLES.tokenAffinityActiveStreams}
        set
          last_touched_at = $2,
          ended_at = null
        where request_id = $1 and ended_at is null
      `,
      [input.requestId, input.touchedAt]
    );

    return result.rowCount > 0;
  }

  async clearActiveStream(input: ClearActiveStreamInput): Promise<TokenAffinityActiveStream | null> {
    const result = await this.db.query<TokenAffinityActiveStreamRow>(
      `
        delete from ${TABLES.tokenAffinityActiveStreams}
        where request_id = $1
        returning
          request_id,
          org_id,
          provider,
          credential_id,
          session_id,
          started_at,
          last_touched_at,
          ended_at
      `,
      [input.requestId]
    );

    return result.rowCount === 1 ? mapActiveStreamRow(result.rows[0]) : null;
  }

  async listBusyCredentialIds(input: ListBusyCredentialIdsInput): Promise<string[]> {
    const result = await this.db.query<CredentialIdRow>(
      `
        select distinct credential_id
        from ${TABLES.tokenAffinityActiveStreams}
        where org_id = $1::uuid and provider = $2 and last_touched_at >= $3 and ended_at is null
        order by credential_id asc
      `,
      [input.orgId, input.provider, input.staleBefore]
    );

    return result.rows.map((row) => row.credential_id);
  }

  async clearStaleActiveStreams(input: ClearStaleActiveStreamsInput): Promise<TokenAffinityActiveStream[]> {
    const result = await this.db.query<TokenAffinityActiveStreamRow>(
      `
        delete from ${TABLES.tokenAffinityActiveStreams}
        where last_touched_at < $1 and ended_at is null
        returning
          request_id,
          org_id,
          provider,
          credential_id,
          session_id,
          started_at,
          last_touched_at,
          ended_at
      `,
      [input.staleBefore]
    );

    return result.rows.map(mapActiveStreamRow);
  }
}
