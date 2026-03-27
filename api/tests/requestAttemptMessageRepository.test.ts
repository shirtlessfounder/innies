import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestAttemptMessageRepository } from '../src/repos/requestAttemptMessageRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive_no_extensions.sql');

describe('RequestAttemptMessageRepository', () => {
  it('persists ordered attempt-message links for canonical reconstruction', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 2 });
    const repo = new RequestAttemptMessageRepository(db);

    await repo.upsertLinks([
      {
        requestAttemptArchiveId: 'archive_1',
        side: 'request',
        ordinal: 0,
        messageBlobId: 'blob_1',
        role: 'system',
        contentType: 'text'
      },
      {
        requestAttemptArchiveId: 'archive_1',
        side: 'request',
        ordinal: 1,
        messageBlobId: 'blob_2',
        role: 'user',
        contentType: 'text'
      }
    ]);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_request_attempt_messages');
    expect(db.queries[0].sql).toContain('on conflict (request_attempt_archive_id, side, ordinal)');
    expect(db.queries[0].params).toEqual([
      'archive_1', 'request', 0, 'blob_1', 'system', 'text',
      'archive_1', 'request', 1, 'blob_2', 'user', 'text'
    ]);
  });

  it('reads message links back in ordinal order', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_attempt_archive_id: 'archive_1',
        side: 'response',
        ordinal: 0
      }],
      rowCount: 1
    });
    const repo = new RequestAttemptMessageRepository(db);

    const rows = await repo.listByArchiveId('archive_1', 'response');

    expect(rows).toHaveLength(1);
    expect(db.queries[0].sql).toContain('where request_attempt_archive_id = $1');
    expect(db.queries[0].sql).toContain('and side = $2');
    expect(db.queries[0].sql).toContain('order by ordinal asc');
    expect(db.queries[0].params).toEqual(['archive_1', 'response']);
  });

  it('rejects duplicate attempt-message edges when the stored link differs', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          request_attempt_archive_id: 'archive_1',
          side: 'request',
          ordinal: 0,
          message_blob_id: 'blob_existing',
          role: 'system',
          content_type: 'json',
          created_at: '2026-03-26T03:00:05Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new RequestAttemptMessageRepository(db);

    await expect(repo.upsertLinks([
      {
        requestAttemptArchiveId: 'archive_1',
        side: 'request',
        ordinal: 0,
        messageBlobId: 'blob_1',
        role: 'system',
        contentType: 'text'
      }
    ])).rejects.toThrow('request attempt message idempotent replay mismatch');
  });

  it('defines ordered-edge uniqueness in both migration variants', () => {
    const candidates = [
      readFileSync(migrationPath, 'utf8'),
      readFileSync(noExtensionsMigrationPath, 'utf8')
    ];

    for (const sql of candidates) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_request_attempt_messages');
      expect(sql).toContain('PRIMARY KEY (request_attempt_archive_id, side, ordinal)');
      expect(sql).toContain('REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE');
      expect(sql).toContain('REFERENCES in_message_blobs(id) ON DELETE RESTRICT');
    }
  });
});
