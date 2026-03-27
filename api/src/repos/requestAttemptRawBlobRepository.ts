import type { SqlClient } from './sqlClient.js';
import { TABLES } from './tableNames.js';

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
      do update set
        raw_blob_id = excluded.raw_blob_id
      returning *
    `;

    const result = await this.db.query<RequestAttemptRawBlobRow>(sql, [
      input.requestAttemptArchiveId,
      input.blobRole,
      input.rawBlobId
    ]);
    if (result.rowCount !== 1) {
      throw new Error('expected one request attempt raw blob row');
    }
    return result.rows[0];
  }

  async listByArchiveId(requestAttemptArchiveId: string): Promise<RequestAttemptRawBlobRow[]> {
    const sql = `
      select *
      from ${TABLES.requestAttemptRawBlobs}
      where request_attempt_archive_id = $1
      order by blob_role asc
    `;
    const result = await this.db.query<RequestAttemptRawBlobRow>(sql, [requestAttemptArchiveId]);
    return result.rows;
  }
}
