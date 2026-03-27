import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessageBlobRepository } from '../src/repos/messageBlobRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive_no_extensions.sql');

const sampleBlob = {
  contentHash: 'hash_message_1',
  kind: 'message' as const,
  role: 'assistant',
  contentType: 'text',
  normalizedPayload: {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello world' }]
  },
  normalizedPayloadCodecVersion: 1
};

describe('MessageBlobRepository', () => {
  it('dedupes normalized blobs globally by content hash', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'blob_existing',
          content_hash: 'hash_message_1'
        }],
        rowCount: 1
      }
    ]);
    const repo = new MessageBlobRepository(db, () => 'blob_new');

    const row = await repo.upsertBlob(sampleBlob);

    expect(row).toEqual(expect.objectContaining({ id: 'blob_existing', content_hash: 'hash_message_1' }));
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].sql).toContain('insert into in_message_blobs');
    expect(db.queries[0].sql).toContain('on conflict (content_hash)');
    expect(db.queries[0].sql).not.toContain('org_id');
    expect(db.queries[1].sql).toContain('where content_hash = $1');
    expect(db.queries[1].params).toEqual(['hash_message_1']);
  });

  it('stores normalized payload metadata for first-class content blobs', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'blob_1',
        content_hash: 'hash_message_1',
        kind: 'message',
        role: 'assistant',
        content_type: 'text',
        normalized_payload: sampleBlob.normalizedPayload,
        normalized_payload_codec_version: 1
      }],
      rowCount: 1
    });
    const repo = new MessageBlobRepository(db, () => 'blob_1');

    await repo.upsertBlob(sampleBlob);

    expect(db.queries[0].params).toContain('hash_message_1');
    expect(db.queries[0].params).toContain('message');
    expect(db.queries[0].params).toContain('assistant');
    expect(db.queries[0].params).toContain('text');
    expect(db.queries[0].params).toContain(1);
  });

  it('defines global content-hash dedupe in both migration variants', () => {
    const candidates = [
      readFileSync(migrationPath, 'utf8'),
      readFileSync(noExtensionsMigrationPath, 'utf8')
    ];

    for (const sql of candidates) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_message_blobs');
      expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_message_blobs_content_hash');
      expect(sql).toContain('ON in_message_blobs (content_hash)');
    }
  });
});
