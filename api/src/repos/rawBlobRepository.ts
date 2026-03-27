import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';

export type RawBlobKind = 'raw_request' | 'raw_response' | 'raw_stream';
export type RawBlobEncoding = 'gzip' | 'none';

export type RawBlobInput = {
  contentHash: string;
  blobKind: RawBlobKind;
  encoding: RawBlobEncoding;
  bytesCompressed: number;
  bytesUncompressed: number;
  payload: Buffer;
};

export type RawBlobRow = {
  id: string;
  content_hash: string;
  blob_kind: RawBlobKind;
  encoding: RawBlobEncoding;
  bytes_compressed: number;
  bytes_uncompressed: number;
  payload: Buffer;
  created_at: string | Date;
};

export class RawBlobRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async upsertBlob(input: RawBlobInput): Promise<RawBlobRow> {
    const sql = `
      insert into ${TABLES.rawBlobs} (
        id,
        content_hash,
        blob_kind,
        encoding,
        bytes_compressed,
        bytes_uncompressed,
        payload
      ) values (
        $1,$2,$3,$4,$5,$6,$7
      )
      on conflict (content_hash, blob_kind)
      do nothing
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.contentHash,
      input.blobKind,
      input.encoding,
      input.bytesCompressed,
      input.bytesUncompressed,
      input.payload
    ];

    const result = await this.db.query<RawBlobRow>(sql, params);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findByContentHashAndKind(input.contentHash, input.blobKind);
    if (existing) {
      assertRawBlobReplayMatches(input, existing);
      return existing;
    }

    throw new Error('expected one raw blob row');
  }

  async findByContentHashAndKind(contentHash: string, blobKind: RawBlobKind): Promise<RawBlobRow | null> {
    const sql = `
      select *
      from ${TABLES.rawBlobs}
      where content_hash = $1
        and blob_kind = $2
      limit 1
    `;
    const result = await this.db.query<RawBlobRow>(sql, [contentHash, blobKind]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

function assertRawBlobReplayMatches(input: RawBlobInput, row: RawBlobRow): void {
  assertIdempotentReplayMatches('raw blob', [
    { field: 'contentHash', expected: input.contentHash, actual: row.content_hash },
    { field: 'blobKind', expected: input.blobKind, actual: row.blob_kind },
    { field: 'encoding', expected: input.encoding, actual: row.encoding },
    { field: 'bytesCompressed', expected: input.bytesCompressed, actual: row.bytes_compressed },
    { field: 'bytesUncompressed', expected: input.bytesUncompressed, actual: row.bytes_uncompressed },
    { field: 'payload', expected: input.payload, actual: row.payload }
  ]);
}
