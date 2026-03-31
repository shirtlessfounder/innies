import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RawBlobRepository } from '../src/repos/rawBlobRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive_no_extensions.sql');

const sampleRawBlob = {
  contentHash: 'hash_raw_response_1',
  blobKind: 'raw_response' as const,
  encoding: 'gzip' as const,
  bytesCompressed: 42,
  bytesUncompressed: 128,
  payload: Buffer.from('compressed-wire-payload')
};

describe('RawBlobRepository', () => {
  it('dedupes raw payloads by content hash and blob kind', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'raw_existing',
          content_hash: 'hash_raw_response_1',
          blob_kind: 'raw_response',
          encoding: 'gzip',
          bytes_compressed: 42,
          bytes_uncompressed: 128,
          payload: sampleRawBlob.payload,
          created_at: '2026-03-26T03:00:05Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new RawBlobRepository(db, () => 'raw_new');

    const row = await repo.upsertBlob(sampleRawBlob);

    expect(row).toEqual(expect.objectContaining({ id: 'raw_existing', content_hash: 'hash_raw_response_1' }));
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].sql).toContain('insert into in_raw_blobs');
    expect(db.queries[0].sql).toContain('on conflict (content_hash, blob_kind)');
    expect(db.queries[1].sql).toContain('where content_hash = $1');
    expect(db.queries[1].sql).toContain('and blob_kind = $2');
    expect(db.queries[1].params).toEqual(['hash_raw_response_1', 'raw_response']);
  });

  it('stores raw payload compression metadata', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'raw_1',
        content_hash: 'hash_raw_response_1',
        blob_kind: 'raw_response',
        encoding: 'gzip'
      }],
      rowCount: 1
    });
    const repo = new RawBlobRepository(db, () => 'raw_1');

    await repo.upsertBlob(sampleRawBlob);

    expect(db.queries[0].params).toContain('hash_raw_response_1');
    expect(db.queries[0].params).toContain('raw_response');
    expect(db.queries[0].params).toContain('gzip');
    expect(db.queries[0].params).toContain(42);
    expect(db.queries[0].params).toContain(128);
    expect(db.queries[0].params).toContain(sampleRawBlob.payload);
  });

  it('rejects duplicate hash replays when the stored raw blob differs', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'raw_existing',
          content_hash: 'hash_raw_response_1',
          blob_kind: 'raw_response',
          encoding: 'gzip',
          bytes_compressed: 42,
          bytes_uncompressed: 128,
          payload: Buffer.from('drifted-wire-payload'),
          created_at: '2026-03-26T03:00:05Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new RawBlobRepository(db, () => 'raw_new');

    await expect(repo.upsertBlob(sampleRawBlob)).rejects.toThrow('raw blob idempotent replay mismatch');
  });

  it('lists raw blobs by ids in the caller-specified order', async () => {
    const db = new MockSqlClient({
      rows: [
        { id: 'raw_2' },
        { id: 'raw_1' }
      ],
      rowCount: 2
    });
    const repo = new RawBlobRepository(db);

    const rows = await repo.findByIds(['raw_2', 'raw_1']);

    expect(rows).toHaveLength(2);
    expect(db.queries[0].sql).toContain('where id::text = any($1::text[])');
    expect(db.queries[0].sql).toContain('order by array_position($1::text[], id::text)');
    expect(db.queries[0].params).toEqual([['raw_2', 'raw_1']]);
  });

  it('defines raw blob dedupe in both migration variants', () => {
    const candidates = [
      readFileSync(migrationPath, 'utf8'),
      readFileSync(noExtensionsMigrationPath, 'utf8')
    ];

    for (const sql of candidates) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_raw_blobs');
      expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_raw_blobs_content_hash_kind');
      expect(sql).toContain('ON in_raw_blobs (content_hash, blob_kind)');
    }
  });
});
