import { AggregatesRepository } from '../repos/aggregatesRepository.js';
import { IdempotencyRepository } from '../repos/idempotencyRepository.js';
import { ReconciliationRepository } from '../repos/reconciliationRepository.js';
import { SellerKeyRepository } from '../repos/sellerKeyRepository.js';
import type { SqlClient } from '../repos/sqlClient.js';
import { C1ReconciliationDataSource } from './reconciliationDataSource.js';
import {
  createDailyAggregatesCompactionJob,
  createDailyAggregatesIncrementalJob
} from './dailyAggregatesJob.js';
import { createIdempotencyPurgeJob } from './idempotencyPurgeJob.js';
import { createKeyHealthCheckJob } from './keyHealthJob.js';
import { createReconciliationJob, type ReconciliationDataSource } from './reconciliationJob.js';
import type { JobDefinition } from './types.js';

export function buildDefaultJobs(db: SqlClient, source: ReconciliationDataSource = new C1ReconciliationDataSource(db)): JobDefinition[] {
  const idempotencyRepo = new IdempotencyRepository(db);
  const aggregatesRepo = new AggregatesRepository(db);
  const reconciliationRepo = new ReconciliationRepository(db);
  const sellerKeysRepo = new SellerKeyRepository(db);

  return [
    createIdempotencyPurgeJob(idempotencyRepo),
    createKeyHealthCheckJob(sellerKeysRepo),
    createDailyAggregatesIncrementalJob(aggregatesRepo),
    createDailyAggregatesCompactionJob(aggregatesRepo),
    createReconciliationJob(reconciliationRepo, source)
  ];
}
