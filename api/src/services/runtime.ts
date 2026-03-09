import { buildPgClient } from '../repos/pgClient.js';
import { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { AuditLogRepository } from '../repos/auditLogRepository.js';
import { IdempotencyRepository } from '../repos/idempotencyRepository.js';
import { KillSwitchRepository } from '../repos/killSwitchRepository.js';
import { ModelCompatibilityRepository } from '../repos/modelCompatibilityRepository.js';
import { RoutingEventsRepository } from '../repos/routingEventsRepository.js';
import { SellerKeyRepository } from '../repos/sellerKeyRepository.js';
import { UsageLedgerRepository } from '../repos/usageLedgerRepository.js';
import { UsageQueryRepository } from '../repos/usageQueryRepository.js';
import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import { AnalyticsRepository } from '../repos/analyticsRepository.js';
import { RequestLogRepository } from '../repos/requestLogRepository.js';
import { buildDefaultJobs } from '../jobs/registry.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { KeyPool } from './keyPool.js';
import { RouterEngine } from './routerEngine.js';
import { RoutingService } from './routingService.js';
import { IdempotencyService } from './idempotencyService.js';
import { UsageMeteringWriter } from './metering/usageMeteringWriter.js';
import { TokenCredentialService } from './tokenCredentialService.js';
import { assertRequiredEnv, readRequiredEnv } from '../utils/env.js';

assertRequiredEnv(['DATABASE_URL', 'SELLER_SECRET_ENC_KEY_B64']);
const sql = buildPgClient(readRequiredEnv('DATABASE_URL'));

export const runtime = {
  sql,
  repos: {
    apiKeys: new ApiKeyRepository(sql),
    auditLogs: new AuditLogRepository(sql),
    idempotency: new IdempotencyRepository(sql),
    killSwitch: new KillSwitchRepository(sql),
    modelCompatibility: new ModelCompatibilityRepository(sql),
    routingEvents: new RoutingEventsRepository(sql),
    sellerKeys: new SellerKeyRepository(sql),
    usageLedger: new UsageLedgerRepository(sql),
    usageQuery: new UsageQueryRepository(sql),
    tokenCredentials: new TokenCredentialRepository(sql),
    analytics: new AnalyticsRepository(sql),
    requestLog: new RequestLogRepository(sql)
  },
  services: {
    idempotency: undefined as unknown as IdempotencyService,
    jobs: undefined as unknown as JobScheduler,
    keyPool: new KeyPool(),
    metering: undefined as unknown as UsageMeteringWriter,
    routerEngine: new RouterEngine(),
    routingService: undefined as unknown as RoutingService,
    tokenCredentials: undefined as unknown as TokenCredentialService
  }
};

runtime.services.idempotency = new IdempotencyService(runtime.repos.idempotency);
runtime.services.jobs = new JobScheduler({
  info: (message, fields) => {
    // eslint-disable-next-line no-console
    console.log(`[jobs] ${message}`, fields ?? {});
  },
  error: (message, fields) => {
    // eslint-disable-next-line no-console
    console.error(`[jobs] ${message}`, fields ?? {});
  }
});
runtime.services.metering = new UsageMeteringWriter(runtime.repos.usageLedger);
runtime.services.routingService = new RoutingService(
  runtime.services.keyPool,
  runtime.services.routerEngine
);
runtime.services.tokenCredentials = new TokenCredentialService(
  runtime.repos.tokenCredentials,
  runtime.repos.auditLogs
);

export function startBackgroundJobs(): void {
  runtime.services.jobs.start(buildDefaultJobs(runtime.sql));
}
