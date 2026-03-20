import { buildPgClient } from '../repos/pgClient.js';
import { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { AuditLogRepository } from '../repos/auditLogRepository.js';
import { CanonicalMeteringRepository } from '../repos/canonicalMeteringRepository.js';
import { FnfOwnershipRepository } from '../repos/fnfOwnershipRepository.js';
import { IdempotencyRepository } from '../repos/idempotencyRepository.js';
import { KillSwitchRepository } from '../repos/killSwitchRepository.js';
import { MeteringProjectorStateRepository } from '../repos/meteringProjectorStateRepository.js';
import { ModelCompatibilityRepository } from '../repos/modelCompatibilityRepository.js';
import { RateCardRepository } from '../repos/rateCardRepository.js';
import { RoutingAttributionRepository } from '../repos/routingAttributionRepository.js';
import { RoutingEventsRepository } from '../repos/routingEventsRepository.js';
import { SellerKeyRepository } from '../repos/sellerKeyRepository.js';
import { UsageLedgerRepository } from '../repos/usageLedgerRepository.js';
import { UsageQueryRepository } from '../repos/usageQueryRepository.js';
import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import { TokenCredentialProviderUsageRepository } from '../repos/tokenCredentialProviderUsageRepository.js';
import { AnalyticsRepository } from '../repos/analyticsRepository.js';
import { AnalyticsDashboardSnapshotRepository } from '../repos/analyticsDashboardSnapshotRepository.js';
import { RequestLogRepository } from '../repos/requestLogRepository.js';
import { PilotIdentityRepository } from '../repos/pilotIdentityRepository.js';
import { PilotAdmissionFreezeRepository } from '../repos/pilotAdmissionFreezeRepository.js';
import { buildDefaultJobs } from '../jobs/registry.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { KeyPool } from './keyPool.js';
import { RouterEngine } from './routerEngine.js';
import { RoutingService } from './routingService.js';
import { IdempotencyService } from './idempotencyService.js';
import { UsageMeteringWriter } from './metering/usageMeteringWriter.js';
import { TokenCredentialService } from './tokenCredentialService.js';
import { PilotSessionService } from './pilot/pilotSessionService.js';
import { PilotGithubAuthService } from './pilot/pilotGithubAuthService.js';
import { PilotCutoverService } from './pilot/pilotCutoverService.js';
import { assertRequiredEnv, readRequiredEnv } from '../utils/env.js';
import { AppError } from '../utils/errors.js';

assertRequiredEnv(['DATABASE_URL', 'SELLER_SECRET_ENC_KEY_B64']);
const sql = buildPgClient(readRequiredEnv('DATABASE_URL'));

export const runtime = {
  sql,
  repos: {
    apiKeys: new ApiKeyRepository(sql),
    auditLogs: new AuditLogRepository(sql),
    canonicalMetering: new CanonicalMeteringRepository(sql),
    fnfOwnership: new FnfOwnershipRepository(sql),
    idempotency: new IdempotencyRepository(sql),
    killSwitch: new KillSwitchRepository(sql),
    meteringProjectorStates: new MeteringProjectorStateRepository(sql),
    modelCompatibility: new ModelCompatibilityRepository(sql),
    rateCards: new RateCardRepository(sql),
    routingEvents: new RoutingEventsRepository(sql),
    routingAttribution: new RoutingAttributionRepository(sql),
    sellerKeys: new SellerKeyRepository(sql),
    usageLedger: new UsageLedgerRepository(sql),
    usageQuery: new UsageQueryRepository(sql),
    tokenCredentials: new TokenCredentialRepository(sql),
    tokenCredentialProviderUsage: new TokenCredentialProviderUsageRepository(sql),
    analytics: new AnalyticsRepository(sql),
    analyticsDashboardSnapshots: new AnalyticsDashboardSnapshotRepository(sql),
    requestLog: new RequestLogRepository(sql),
    pilotIdentity: new PilotIdentityRepository(sql),
    pilotAdmissionFreezes: new PilotAdmissionFreezeRepository(sql)
  },
  services: {
    idempotency: undefined as unknown as IdempotencyService,
    jobs: undefined as unknown as JobScheduler,
    keyPool: new KeyPool(),
    metering: undefined as unknown as UsageMeteringWriter,
    pilotCutovers: undefined as unknown as PilotCutoverService,
    pilotGithubAuth: undefined as unknown as PilotGithubAuthService,
    pilotSessions: undefined as unknown as PilotSessionService,
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
runtime.services.metering = new UsageMeteringWriter({
  usageLedgerRepo: runtime.repos.usageLedger,
  canonicalMeteringRepo: runtime.repos.canonicalMetering,
  meteringProjectorStateRepo: runtime.repos.meteringProjectorStates,
  rateCardRepo: runtime.repos.rateCards,
  ownershipRepo: runtime.repos.fnfOwnership
});
runtime.services.pilotSessions = new PilotSessionService({
  secret: process.env.PILOT_SESSION_SECRET || 'dev-insecure-pilot-session-secret'
});
runtime.services.pilotGithubAuth = new PilotGithubAuthService({
  clientId: process.env.PILOT_GITHUB_CLIENT_ID || '',
  clientSecret: process.env.PILOT_GITHUB_CLIENT_SECRET || '',
  callbackUrl: process.env.PILOT_GITHUB_CALLBACK_URL || 'http://localhost:4010/v1/pilot/auth/github/callback',
  allowlistedLogins: (process.env.PILOT_GITHUB_ALLOWLIST_LOGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  allowlistedEmails: (process.env.PILOT_GITHUB_ALLOWLIST_EMAILS || '').split(',').map((value) => value.trim()).filter(Boolean),
  identityRepository: runtime.repos.pilotIdentity,
  sessionService: runtime.services.pilotSessions,
  targetOrgSlug: process.env.PILOT_TARGET_ORG_SLUG || 'fnf',
  targetOrgName: process.env.PILOT_TARGET_ORG_NAME || 'Friends & Family',
  stateSecret: process.env.PILOT_GITHUB_STATE_SECRET || 'dev-insecure-pilot-oauth-state-secret'
});
runtime.services.pilotCutovers = new PilotCutoverService({
  sql: runtime.sql,
  reserveFloorMigration: {
    async migrateReserveFloors(input) {
      await runtime.repos.tokenCredentials.migrateReserveFloors(input);
    }
  }
});
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
