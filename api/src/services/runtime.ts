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
import { TokenCredentialProviderUsageRepository } from '../repos/tokenCredentialProviderUsageRepository.js';
import { AnalyticsRepository } from '../repos/analyticsRepository.js';
import { AnalyticsDashboardSnapshotRepository } from '../repos/analyticsDashboardSnapshotRepository.js';
import { RequestLogRepository } from '../repos/requestLogRepository.js';
import { FnfOwnershipRepository } from '../repos/fnfOwnershipRepository.js';
import { PilotCutoverRepository } from '../repos/pilotCutoverRepository.js';
import { PilotCutoverFreezeRepository } from '../repos/pilotCutoverFreezeRepository.js';
import { PilotIdentityRepository } from '../repos/pilotIdentityRepository.js';
import { buildDefaultJobs } from '../jobs/registry.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { KeyPool } from './keyPool.js';
import { RouterEngine } from './routerEngine.js';
import { RoutingService } from './routingService.js';
import { IdempotencyService } from './idempotencyService.js';
import { UsageMeteringWriter } from './metering/usageMeteringWriter.js';
import { TokenCredentialService } from './tokenCredentialService.js';
import { PilotAccessService } from './pilotAccessService.js';
import { PilotSessionService, createGithubOauthClientFromEnv } from './pilotSessionService.js';
import { assertRequiredEnv, readRequiredEnv } from '../utils/env.js';

assertRequiredEnv(['DATABASE_URL', 'SELLER_SECRET_ENC_KEY_B64']);
const sql = buildPgClient(readRequiredEnv('DATABASE_URL'));
const pilotSessionSecret = process.env.PILOT_SESSION_SECRET || readRequiredEnv('SELLER_SECRET_ENC_KEY_B64');

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
    tokenCredentialProviderUsage: new TokenCredentialProviderUsageRepository(sql),
    analytics: new AnalyticsRepository(sql),
    analyticsDashboardSnapshots: new AnalyticsDashboardSnapshotRepository(sql),
    requestLog: new RequestLogRepository(sql),
    fnfOwnership: new FnfOwnershipRepository(sql),
    pilotCutoverRecords: new PilotCutoverRepository(sql),
    pilotCutoverFreezes: new PilotCutoverFreezeRepository(sql),
    pilotIdentities: new PilotIdentityRepository(sql)
  },
  services: {
    idempotency: undefined as unknown as IdempotencyService,
    jobs: undefined as unknown as JobScheduler,
    keyPool: new KeyPool(),
    metering: undefined as unknown as UsageMeteringWriter,
    pilotAccess: undefined as unknown as PilotAccessService,
    pilotSessions: undefined as unknown as PilotSessionService,
    pilotReserveFloors: {
      async migrateReserveFloors(): Promise<void> {
        throw new Error('routing reserve-floor migrator is not available in this workspace yet');
      }
    },
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
runtime.services.pilotAccess = new PilotAccessService({
  apiKeys: runtime.repos.apiKeys,
  tokenCredentials: runtime.repos.tokenCredentials,
  fnfOwnership: runtime.repos.fnfOwnership,
  cutoverRecords: runtime.repos.pilotCutoverRecords,
  identities: runtime.repos.pilotIdentities,
  freezes: runtime.repos.pilotCutoverFreezes,
  reserveFloors: runtime.services.pilotReserveFloors
});
runtime.services.pilotSessions = new PilotSessionService({
  identities: runtime.repos.pilotIdentities,
  github: createGithubOauthClientFromEnv(),
  sessionSecret: pilotSessionSecret,
  darrynGithubAllowlist: readCsvEnv('PILOT_DARRYN_GITHUB_ALLOWLIST', 'darryn'),
  adminGithubAllowlist: readCsvEnv('PILOT_ADMIN_GITHUB_ALLOWLIST', '')
});

export function startBackgroundJobs(): void {
  runtime.services.jobs.start(buildDefaultJobs(runtime.sql));
}

function readCsvEnv(name: string, fallback: string): string[] {
  const raw = process.env[name] ?? fallback;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
