import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from './sqlClient.js';
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

export type ClaimPreferredAssignmentResult =
  | { outcome: 'claimed'; assignment: TokenAffinityAssignment }
  | { outcome: 'already_owned_by_session'; assignment: TokenAffinityAssignment }
  | { outcome: 'credential_unavailable' }
  | { outcome: 'session_already_bound'; assignment: TokenAffinityAssignment };

export type GetPreferredAssignmentInput = {
  orgId: string;
  provider: string;
  sessionId: string;
};

export type ClaimPreferredAssignmentInput = GetPreferredAssignmentInput & {
  credentialId: string;
};

export type ClearPreferredAssignmentInput = GetPreferredAssignmentInput & {
  credentialId?: string;
};

export type TouchPreferredAssignmentInput = ClaimPreferredAssignmentInput & {
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

function mapAssignment(row: TokenAffinityAssignmentRow): TokenAffinityAssignment {
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

function mapActiveStream(row: TokenAffinityActiveStreamRow): TokenAffinityActiveStream {
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

async function loadClaimConflict(
  tx: TransactionContext,
  input: ClaimPreferredAssignmentInput
): Promise<TokenAffinityAssignment> {
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
      where org_id = $1::uuid
        and provider = $2
        and (session_id = $3 or credential_id = $4::uuid)
      order by
        case when session_id = $3 then 0 else 1 end,
        case when credential_id = $4::uuid then 0 else 1 end
      limit 1
    `,
    [input.orgId, input.provider, input.sessionId, input.credentialId]
  );

  if (result.rowCount !== 1) {
    throw new Error('expected conflicting token affinity assignment after failed claim');
  }

  return mapAssignment(result.rows[0]);
}

export class TokenAffinityRepository {
  constructor(private readonly db: SqlClient) {}

  async getPreferredAssignment(input: GetPreferredAssignmentInput): Promise<TokenAffinityAssignment | null> {
    const result = await this.db.query<TokenAffinityAssignmentRow>(
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
        where org_id = $1::uuid
          and provider = $2
          and session_id = $3
        limit 1
      `,
      [input.orgId, input.provider, input.sessionId]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    return mapAssignment(result.rows[0]);
  }

  async claimPreferredAssignment(input: ClaimPreferredAssignmentInput): Promise<ClaimPreferredAssignmentResult> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<TokenAffinityAssignmentRow>(
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
        [input.orgId, input.provider, input.credentialId, input.sessionId]
      );

      if (result.rowCount === 1) {
        return {
          outcome: 'claimed',
          assignment: mapAssignment(result.rows[0])
        };
      }

      const assignment = await loadClaimConflict(tx, input);
      const sameSession = assignment.sessionId === input.sessionId;
      const sameCredential = assignment.credentialId === input.credentialId;

      if (sameSession && sameCredential) {
        return { outcome: 'already_owned_by_session', assignment };
      }

      if (sameSession) {
        return { outcome: 'session_already_bound', assignment };
      }

      if (sameCredential) {
        return { outcome: 'credential_unavailable' };
      }

      throw new Error('unexpected token affinity claim conflict');
    });
  }

  async clearPreferredAssignment(input: ClearPreferredAssignmentInput): Promise<boolean> {
    const params: SqlValue[] = [input.orgId, input.provider, input.sessionId];
    const credentialFilter = input.credentialId
      ? 'and credential_id = $4::uuid'
      : '';

    if (input.credentialId) {
      params.push(input.credentialId);
    }

    const result = await this.db.query(
      `
        delete from ${TABLES.tokenAffinityAssignments}
        where org_id = $1::uuid
          and provider = $2
          and session_id = $3
          ${credentialFilter}
      `,
      params
    );

    return result.rowCount > 0;
  }

  async touchPreferredAssignment(input: TouchPreferredAssignmentInput): Promise<boolean> {
    const result = await this.db.query(
      `
        update ${TABLES.tokenAffinityAssignments}
        set
          last_activity_at = now(),
          grace_expires_at = $5,
          updated_at = now()
        where org_id = $1::uuid
          and provider = $2
          and session_id = $3
          and credential_id = $4::uuid
      `,
      [input.orgId, input.provider, input.sessionId, input.credentialId, input.graceExpiresAt]
    );

    return result.rowCount > 0;
  }

  async upsertActiveStream(input: UpsertActiveStreamInput): Promise<TokenAffinityActiveStream> {
    const result = await this.db.query<TokenAffinityActiveStreamRow>(
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
          org_id = excluded.org_id,
          provider = excluded.provider,
          credential_id = excluded.credential_id,
          session_id = excluded.session_id,
          last_touched_at = now(),
          ended_at = null
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
      [input.requestId, input.orgId, input.provider, input.credentialId, input.sessionId]
    );

    if (result.rowCount !== 1) {
      throw new Error('expected active stream upsert');
    }

    return mapActiveStream(result.rows[0]);
  }

  async touchActiveStream(input: TouchActiveStreamInput): Promise<boolean> {
    const result = await this.db.query(
      `
        update ${TABLES.tokenAffinityActiveStreams}
        set
          last_touched_at = $2,
          ended_at = null
        where request_id = $1
          and ended_at is null
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

    if (result.rowCount !== 1) {
      return null;
    }

    return mapActiveStream(result.rows[0]);
  }

  async listBusyCredentialIds(input: ListBusyCredentialIdsInput): Promise<string[]> {
    const result = await this.db.query<{ credential_id: string }>(
      `
        select distinct credential_id
        from ${TABLES.tokenAffinityActiveStreams}
        where org_id = $1::uuid
          and provider = $2
          and ended_at is null
          and last_touched_at >= $3
        order by credential_id asc
      `,
      [input.orgId, input.provider, input.staleBefore]
    );

    return result.rows.map((row) => row.credential_id);
  }

  async clearStaleActiveStreams(input: ClearStaleActiveStreamsInput): Promise<TokenAffinityActiveStream[]> {
    const result = await this.db.query<TokenAffinityActiveStreamRow>(
      `
        with cleared_streams as (
          delete from ${TABLES.tokenAffinityActiveStreams}
          where ended_at is null
            and last_touched_at < $1
          returning
            request_id,
            org_id,
            provider,
            credential_id,
            session_id,
            started_at,
            last_touched_at,
            ended_at
        ), cleared_assignments as (
          delete from ${TABLES.tokenAffinityAssignments} assignment
          using cleared_streams stream
          where assignment.org_id = stream.org_id
            and assignment.provider = stream.provider
            and assignment.credential_id = stream.credential_id
            and assignment.session_id = stream.session_id
            and not exists (
              select 1
              from ${TABLES.tokenAffinityActiveStreams} live
              where live.org_id = stream.org_id
                and live.provider = stream.provider
                and live.credential_id = stream.credential_id
                and live.session_id = stream.session_id
                and live.ended_at is null
            )
        )
        select
          request_id,
          org_id,
          provider,
          credential_id,
          session_id,
          started_at,
          last_touched_at,
          ended_at
        from cleared_streams
        order by last_touched_at asc, request_id asc
      `,
      [input.staleBefore]
    );

    return result.rows.map(mapActiveStream);
  }
}
