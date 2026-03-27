import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type MessageBlobKind = 'message' | 'part';

export type MessageBlobInput = {
  contentHash: string;
  kind: MessageBlobKind;
  role?: string | null;
  contentType: string;
  normalizedPayload: Record<string, unknown>;
  normalizedPayloadCodecVersion?: number;
};

export type MessageBlobRow = {
  id: string;
  content_hash: string;
  kind: MessageBlobKind;
  role: string | null;
  content_type: string;
  normalized_payload: Record<string, unknown>;
  normalized_payload_codec_version: number;
  created_at: string | Date;
};

export class MessageBlobRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async upsertBlob(input: MessageBlobInput): Promise<MessageBlobRow> {
    const sql = `
      insert into ${TABLES.messageBlobs} (
        id,
        content_hash,
        kind,
        role,
        content_type,
        normalized_payload,
        normalized_payload_codec_version
      ) values (
        $1,$2,$3,$4,$5,$6,$7
      )
      on conflict (content_hash)
      do nothing
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.contentHash,
      input.kind,
      input.role ?? null,
      input.contentType,
      input.normalizedPayload,
      input.normalizedPayloadCodecVersion ?? 1
    ];

    const result = await this.db.query<MessageBlobRow>(sql, params);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findByContentHash(input.contentHash);
    if (existing) {
      return existing;
    }

    throw new Error('expected one message blob row');
  }

  async findByContentHash(contentHash: string): Promise<MessageBlobRow | null> {
    const sql = `
      select *
      from ${TABLES.messageBlobs}
      where content_hash = $1
      limit 1
    `;
    const result = await this.db.query<MessageBlobRow>(sql, [contentHash]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}
