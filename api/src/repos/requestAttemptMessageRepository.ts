import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';

export type RequestAttemptMessageSide = 'request' | 'response';

export type RequestAttemptMessageLinkInput = {
  requestAttemptArchiveId: string;
  side: RequestAttemptMessageSide;
  ordinal: number;
  messageBlobId: string;
  role?: string | null;
  contentType: string;
};

export type RequestAttemptMessageRow = {
  request_attempt_archive_id: string;
  side: RequestAttemptMessageSide;
  ordinal: number;
  message_blob_id: string;
  role: string | null;
  content_type: string;
  created_at: string | Date;
};

export class RequestAttemptMessageRepository {
  constructor(private readonly db: SqlClient) {}

  async upsertLinks(input: RequestAttemptMessageLinkInput[]): Promise<void> {
    if (input.length === 0) {
      return;
    }

    const values: string[] = [];
    const params: SqlValue[] = [];

    input.forEach((link, index) => {
      const offset = index * 6;
      values.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`);
      params.push(
        link.requestAttemptArchiveId,
        link.side,
        link.ordinal,
        link.messageBlobId,
        link.role ?? null,
        link.contentType
      );
    });

    const sql = `
      insert into ${TABLES.requestAttemptMessages} (
        request_attempt_archive_id,
        side,
        ordinal,
        message_blob_id,
        role,
        content_type
      ) values ${values.join(', ')}
      on conflict (request_attempt_archive_id, side, ordinal)
      do nothing
    `;

    const result = await this.db.query(sql, params);
    if (result.rowCount === input.length) {
      return;
    }

    for (const link of input) {
      const existing = await this.findLink(link);
      if (!existing) {
        throw new Error('expected one request attempt message row');
      }
      assertRequestAttemptMessageReplayMatches(link, existing);
    }
  }

  async listByArchiveId(
    requestAttemptArchiveId: string,
    side?: RequestAttemptMessageSide
  ): Promise<RequestAttemptMessageRow[]> {
    const params: SqlValue[] = [requestAttemptArchiveId];
    const where = ['request_attempt_archive_id = $1'];
    let orderBy = 'side asc, ordinal asc';

    if (side) {
      params.push(side);
      where.push(`side = $${params.length}`);
      orderBy = 'ordinal asc';
    }

    const sql = `
      select *
      from ${TABLES.requestAttemptMessages}
      where ${where.join(' and ')}
      order by ${orderBy}
    `;

    const result = await this.db.query<RequestAttemptMessageRow>(sql, params);
    return result.rows;
  }

  private async findLink(input: Pick<RequestAttemptMessageLinkInput, 'requestAttemptArchiveId' | 'side' | 'ordinal'>): Promise<RequestAttemptMessageRow | null> {
    const sql = `
      select *
      from ${TABLES.requestAttemptMessages}
      where request_attempt_archive_id = $1
        and side = $2
        and ordinal = $3
      limit 1
    `;
    const result = await this.db.query<RequestAttemptMessageRow>(sql, [
      input.requestAttemptArchiveId,
      input.side,
      input.ordinal
    ]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

function assertRequestAttemptMessageReplayMatches(
  input: RequestAttemptMessageLinkInput,
  row: RequestAttemptMessageRow
): void {
  assertIdempotentReplayMatches('request attempt message', [
    { field: 'requestAttemptArchiveId', expected: input.requestAttemptArchiveId, actual: row.request_attempt_archive_id },
    { field: 'side', expected: input.side, actual: row.side },
    { field: 'ordinal', expected: input.ordinal, actual: row.ordinal },
    { field: 'messageBlobId', expected: input.messageBlobId, actual: row.message_blob_id },
    { field: 'role', expected: input.role ?? null, actual: row.role },
    { field: 'contentType', expected: input.contentType, actual: row.content_type }
  ]);
}
