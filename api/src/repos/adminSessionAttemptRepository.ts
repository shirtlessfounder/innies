import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type AdminSessionAttemptRow = {
  session_key: string;
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  event_time: string;
  sequence_no: number;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  created_at: string;
};

export class AdminSessionAttemptRepository {
  constructor(private readonly db: SqlClient) {}

  upsertAttemptLink(input: {
    sessionKey: string;
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    eventTime: Date;
    sequenceNo: number;
    provider: string;
    model: string;
    streaming: boolean;
    status: AdminSessionAttemptRow['status'];
  }): Promise<AdminSessionAttemptRow> {
    const sql = `
      insert into ${TABLES.adminSessionAttempts} (
        session_key,
        request_attempt_archive_id,
        request_id,
        attempt_no,
        event_time,
        sequence_no,
        provider,
        model,
        streaming,
        status,
        created_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()
      )
      on conflict (session_key, request_attempt_archive_id)
      do update set
        request_id = excluded.request_id,
        attempt_no = excluded.attempt_no,
        event_time = excluded.event_time,
        sequence_no = excluded.sequence_no,
        provider = excluded.provider,
        model = excluded.model,
        streaming = excluded.streaming,
        status = excluded.status
      returning *
    `;

    return this.expectOne(sql, [
      input.sessionKey,
      input.requestAttemptArchiveId,
      input.requestId,
      input.attemptNo,
      input.eventTime,
      input.sequenceNo,
      input.provider,
      input.model,
      input.streaming,
      input.status
    ]);
  }

  listAttemptsBySessionKey(sessionKey: string): Promise<AdminSessionAttemptRow[]> {
    const sql = `
      select *
      from ${TABLES.adminSessionAttempts}
      where session_key = $1
      order by event_time asc, request_id asc, attempt_no asc, sequence_no asc
    `;
    return this.db.query<AdminSessionAttemptRow>(sql, [sessionKey]).then((result) => result.rows);
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminSessionAttemptRow> {
    const result = await this.db.query<AdminSessionAttemptRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin session attempt row');
    }
    return result.rows[0];
  }
}
