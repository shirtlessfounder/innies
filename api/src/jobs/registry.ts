import { AggregatesRepository } from '../repos/aggregatesRepository.js';
import { IdempotencyRepository } from '../repos/idempotencyRepository.js';
import { ReconciliationRepository } from '../repos/reconciliationRepository.js';
import { RequestLogRepository } from '../repos/requestLogRepository.js';
import { SellerKeyRepository } from '../repos/sellerKeyRepository.js';
import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import type { SqlClient } from '../repos/sqlClient.js';
import { C1ReconciliationDataSource } from './reconciliationDataSource.js';
import {
  createDailyAggregatesCompactionJob,
  createDailyAggregatesIncrementalJob
} from './dailyAggregatesJob.js';
import { createIdempotencyPurgeJob } from './idempotencyPurgeJob.js';
import { createKeyHealthCheckJob } from './keyHealthJob.js';
import { createRequestLogRetentionJob } from './requestLogRetentionJob.js';
import { createTokenCredentialHealthJob } from './tokenCredentialHealthJob.js';
import { createReconciliationJob, type ReconciliationDataSource } from './reconciliationJob.js';
import type { JobDefinition } from './types.js';

export function buildDefaultJobs(db: SqlClient, source: ReconciliationDataSource = new C1ReconciliationDataSource(db)): JobDefinition[] {
  const idempotencyRepo = new IdempotencyRepository(db);
  const aggregatesRepo = new AggregatesRepository(db);
  const reconciliationRepo = new ReconciliationRepository(db);
  const requestLogRepo = new RequestLogRepository(db);
  const sellerKeysRepo = new SellerKeyRepository(db);
  const tokenCredentialsRepo = new TokenCredentialRepository(db);

  return [
    createIdempotencyPurgeJob(idempotencyRepo),
    createKeyHealthCheckJob(sellerKeysRepo),
    createTokenCredentialHealthJob(tokenCredentialsRepo),
    createDailyAggregatesIncrementalJob(aggregatesRepo),
    createDailyAggregatesCompactionJob(aggregatesRepo),
    createRequestLogRetentionJob(requestLogRepo),
    createReconciliationJob(reconciliationRepo, source)
  ];
}
