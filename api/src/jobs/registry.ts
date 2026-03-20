import { AggregatesRepository } from '../repos/aggregatesRepository.js';
import { IdempotencyRepository } from '../repos/idempotencyRepository.js';
import { ReconciliationRepository } from '../repos/reconciliationRepository.js';
import { RequestLogRepository } from '../repos/requestLogRepository.js';
import { SellerKeyRepository } from '../repos/sellerKeyRepository.js';
import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import { TokenCredentialProviderUsageRepository } from '../repos/tokenCredentialProviderUsageRepository.js';
import { WalletLedgerRepository } from '../repos/walletLedgerRepository.js';
import { CanonicalMeteringRepository } from '../repos/canonicalMeteringRepository.js';
import { MeteringProjectorStateRepository } from '../repos/meteringProjectorStateRepository.js';
import type { SqlClient } from '../repos/sqlClient.js';
import { WalletService } from '../services/wallet/walletService.js';
import { C1ReconciliationDataSource } from './reconciliationDataSource.js';
import {
  createDailyAggregatesCompactionJob,
  createDailyAggregatesIncrementalJob
} from './dailyAggregatesJob.js';
import { createIdempotencyPurgeJob } from './idempotencyPurgeJob.js';
import { createKeyHealthCheckJob } from './keyHealthJob.js';
import { createRequestLogRetentionJob } from './requestLogRetentionJob.js';
import { createTokenCredentialHealthJob } from './tokenCredentialHealthJob.js';
import { createTokenCredentialProviderUsageJob } from './tokenCredentialProviderUsageJob.js';
import { createWalletProjectorJob } from './walletProjectorJob.js';
import { createReconciliationJob, type ReconciliationDataSource } from './reconciliationJob.js';
import type { JobDefinition } from './types.js';

export function buildDefaultJobs(db: SqlClient, source: ReconciliationDataSource = new C1ReconciliationDataSource(db)): JobDefinition[] {
  const idempotencyRepo = new IdempotencyRepository(db);
  const aggregatesRepo = new AggregatesRepository(db);
  const reconciliationRepo = new ReconciliationRepository(db);
  const requestLogRepo = new RequestLogRepository(db);
  const sellerKeysRepo = new SellerKeyRepository(db);
  const tokenCredentialsRepo = new TokenCredentialRepository(db);
  const tokenCredentialProviderUsageRepo = new TokenCredentialProviderUsageRepository(db);
  const walletLedgerRepo = new WalletLedgerRepository(db);
  const canonicalMeteringRepo = new CanonicalMeteringRepository(db);
  const meteringProjectorStateRepo = new MeteringProjectorStateRepository(db);
  const walletService = new WalletService({
    sql: db,
    walletLedgerRepo,
    canonicalMeteringRepo,
    meteringProjectorStateRepo
  });

  return [
    createIdempotencyPurgeJob(idempotencyRepo),
    createKeyHealthCheckJob(sellerKeysRepo),
    createTokenCredentialProviderUsageJob(tokenCredentialsRepo, tokenCredentialProviderUsageRepo),
    createWalletProjectorJob({
      walletService,
      meteringProjectorStateRepo
    }),
    createTokenCredentialHealthJob(tokenCredentialsRepo),
    createDailyAggregatesIncrementalJob(aggregatesRepo),
    createDailyAggregatesCompactionJob(aggregatesRepo),
    createRequestLogRetentionJob(requestLogRepo),
    createReconciliationJob(reconciliationRepo, source)
  ];
}
