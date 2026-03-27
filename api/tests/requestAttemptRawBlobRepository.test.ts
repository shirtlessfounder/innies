import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestAttemptRawBlobRepository } from '../src/repos/requestAttemptRawBlobRepository.js';
import { MockSqlClient } from './testHelpers.js';

const migrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/024_prompt_storage_archive_no_extensions.sql');

describe('RequestAttemptRawBlobRepository', () => {
  it('upserts blob-role keyed raw blob links per archived attempt', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_attempt_archive_id: 'archive_1',
        blob_role: 'stream',
        raw_blob_id: 'raw_1'
      }],
      rowCount: 1
    });
    const repo = new RequestAttemptRawBlobRepository(db);

    const row = await repo.upsertLink({
      requestAttemptArchiveId: 'archive_1',
      blobRole: 'stream',
      rawBlobId: 'raw_1'
    });

    expect(row).toEqual(expect.objectContaining({ blob_role: 'stream', raw_blob_id: 'raw_1' }));
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_request_attempt_raw_blobs');
    expect(db.queries[0].sql).toContain('on conflict (request_attempt_archive_id, blob_role)');
    expect(db.queries[0].params).toEqual(['archive_1', 'stream', 'raw_1']);
  });

  it('lists raw blob links for an archived attempt', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_attempt_archive_id: 'archive_1',
        blob_role: 'request',
        raw_blob_id: 'raw_req_1'
      }],
      rowCount: 1
    });
    const repo = new RequestAttemptRawBlobRepository(db);

    const rows = await repo.listByArchiveId('archive_1');

    expect(rows).toHaveLength(1);
    expect(db.queries[0].sql).toContain('where request_attempt_archive_id = $1');
    expect(db.queries[0].sql).toContain('order by blob_role asc');
    expect(db.queries[0].params).toEqual(['archive_1']);
  });

  it('defines raw blob link uniqueness in both migration variants', () => {
    const candidates = [
      readFileSync(migrationPath, 'utf8'),
      readFileSync(noExtensionsMigrationPath, 'utf8')
    ];

    for (const sql of candidates) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_request_attempt_raw_blobs');
      expect(sql).toContain('PRIMARY KEY (request_attempt_archive_id, blob_role)');
      expect(sql).toContain('REFERENCES in_request_attempt_archives(id) ON DELETE CASCADE');
      expect(sql).toContain('REFERENCES in_raw_blobs(id) ON DELETE RESTRICT');
    }
  });
});
