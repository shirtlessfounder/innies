import type { SqlClient } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';

export type RequestAttemptRawBlobRole = 'request' | 'response' | 'stream';

export type RequestAttemptRawBlobLinkInput = {
  requestAttemptArchiveId: string;
  blobRole: RequestAttemptRawBlobRole;
  rawBlobId: string;
};

export type RequestAttemptRawBlobRow = {
  request_attempt_archive_id: string;
  blob_role: RequestAttemptRawBlobRole;
  raw_blob_id: string;
  created_at: string | Date;
};

const REQUEST_ATTEMPT_RAW_BLOB_ORDER =
  "case blob_role when 'request' then 0 when 'response' then 1 when 'stream' then 2 else 3 end";

export class RequestAttemptRawBlobRepository {
  constructor(private readonly db: SqlClient) {}

  async upsertLink(input: RequestAttemptRawBlobLinkInput): Promise<RequestAttemptRawBlobRow> {
    const sql = `
      insert into ${TABLES.requestAttemptRawBlobs} (
        request_attempt_archive_id,
        blob_role,
        raw_blob_id
      ) values (
        $1,$2,$3
      )
      on conflict (request_attempt_archive_id, blob_role)
      do nothing
      returning *
    `;

    const result = await this.db.query<RequestAttemptRawBlobRow>(sql, [
      input.requestAttemptArchiveId,
      input.blobRole,
      input.rawBlobId
    ]);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findByArchiveIdAndRole(input.requestAttemptArchiveId, input.blobRole);
    if (!existing) {
      throw new Error('expected one request attempt raw blob row');
    }

    assertRequestAttemptRawBlobReplayMatches(input, existing);
    return existing;
  }

  async listByArchiveId(requestAttemptArchiveId: string): Promise<RequestAttemptRawBlobRow[]> {
    const sql = `
      select *
      from ${TABLES.requestAttemptRawBlobs}
      where request_attempt_archive_id = $1
      order by ${REQUEST_ATTEMPT_RAW_BLOB_ORDER}
    `;
    const result = await this.db.query<RequestAttemptRawBlobRow>(sql, [requestAttemptArchiveId]);
    return result.rows;
  }

  async findByArchiveIdAndRole(
    requestAttemptArchiveId: string,
    blobRole: RequestAttemptRawBlobRole
  ): Promise<RequestAttemptRawBlobRow | null> {
    const sql = `
      select *
      from ${TABLES.requestAttemptRawBlobs}
      where request_attempt_archive_id = $1
        and blob_role = $2
      limit 1
    `;
    const result = await this.db.query<RequestAttemptRawBlobRow>(sql, [
      requestAttemptArchiveId,
      blobRole
    ]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

function assertRequestAttemptRawBlobReplayMatches(
  input: RequestAttemptRawBlobLinkInput,
  row: RequestAttemptRawBlobRow
): void {
  assertIdempotentReplayMatches('request attempt raw blob', [
    { field: 'requestAttemptArchiveId', expected: input.requestAttemptArchiveId, actual: row.request_attempt_archive_id },
    { field: 'blobRole', expected: input.blobRole, actual: row.blob_role },
    { field: 'rawBlobId', expected: input.rawBlobId, actual: row.raw_blob_id }
  ]);
}
