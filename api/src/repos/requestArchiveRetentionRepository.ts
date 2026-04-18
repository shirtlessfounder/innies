import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type RetentionBatchResult = {
  deletedCount: number;
};

export type RetentionCutoffInput = {
  cutoff: Date;
  batchSize: number;
};

export type RetentionSweepInput = {
  batchSize: number;
};

function clampBatchSize(batchSize: number): number {
  if (!Number.isFinite(batchSize)) return 1;
  return Math.max(1, Math.floor(batchSize));
}

/**
 * Retention + orphan-sweep queries for the prompt-archive storage introduced
 * in migration 024 (in_request_attempt_archives, in_raw_blobs, in_message_blobs).
 *
 * Deletes are batched so the retention job can bound its transaction size and
 * yield between batches. Orphan sweeps are separate from the archive delete
 * because in_raw_blobs and in_message_blobs use ON DELETE RESTRICT from the
 * link tables, so the parent archive delete cascades the joins but cannot
 * reach the blob rows directly.
 */
export class RequestArchiveRetentionRepository {
  constructor(private readonly db: SqlClient) {}

  async deleteArchivesOlderThan(input: RetentionCutoffInput): Promise<RetentionBatchResult> {
    const sql = `
      delete from ${TABLES.requestAttemptArchives}
      where id in (
        select id
        from ${TABLES.requestAttemptArchives}
        where created_at < $1
        order by created_at asc
        limit $2
      )
    `;
    const params: SqlValue[] = [input.cutoff, clampBatchSize(input.batchSize)];
    const result = await this.db.query(sql, params);
    return { deletedCount: result.rowCount };
  }

  async sweepOrphanedRawBlobs(input: RetentionSweepInput): Promise<RetentionBatchResult> {
    const sql = `
      delete from ${TABLES.rawBlobs}
      where id in (
        select rb.id
        from ${TABLES.rawBlobs} rb
        where not exists (
          select 1
          from ${TABLES.requestAttemptRawBlobs} link
          where link.raw_blob_id = rb.id
        )
        limit $1
      )
    `;
    const params: SqlValue[] = [clampBatchSize(input.batchSize)];
    const result = await this.db.query(sql, params);
    return { deletedCount: result.rowCount };
  }

  async sweepOrphanedMessageBlobs(input: RetentionSweepInput): Promise<RetentionBatchResult> {
    const sql = `
      delete from ${TABLES.messageBlobs}
      where id in (
        select mb.id
        from ${TABLES.messageBlobs} mb
        where not exists (
          select 1
          from ${TABLES.requestAttemptMessages} link
          where link.message_blob_id = mb.id
        )
        limit $1
      )
    `;
    const params: SqlValue[] = [clampBatchSize(input.batchSize)];
    const result = await this.db.query(sql, params);
    return { deletedCount: result.rowCount };
  }

  async purgeProjectedSessionOutbox(input: RetentionCutoffInput): Promise<RetentionBatchResult> {
    const sql = `
      delete from ${TABLES.adminSessionProjectionOutbox}
      where id in (
        select id
        from ${TABLES.adminSessionProjectionOutbox}
        where projection_state = 'projected'
          and processed_at is not null
          and processed_at < $1
        order by processed_at asc
        limit $2
      )
    `;
    const params: SqlValue[] = [input.cutoff, clampBatchSize(input.batchSize)];
    const result = await this.db.query(sql, params);
    return { deletedCount: result.rowCount };
  }

  async purgeProjectedAnalysisOutbox(input: RetentionCutoffInput): Promise<RetentionBatchResult> {
    const sql = `
      delete from ${TABLES.adminAnalysisProjectionOutbox}
      where id in (
        select id
        from ${TABLES.adminAnalysisProjectionOutbox}
        where projection_state = 'projected'
          and processed_at is not null
          and processed_at < $1
        order by processed_at asc
        limit $2
      )
    `;
    const params: SqlValue[] = [input.cutoff, clampBatchSize(input.batchSize)];
    const result = await this.db.query(sql, params);
    return { deletedCount: result.rowCount };
  }
}
