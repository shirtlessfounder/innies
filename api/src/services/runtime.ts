import { buildPgClient } from '../repos/pgClient.js';
import { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { AuditLogRepository } from '../repos/auditLogRepository.js';
import { CanonicalMeteringRepository } from '../repos/canonicalMeteringRepository.js';
import { EarningsLedgerRepository } from '../repos/earningsLedgerRepository.js';
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
import { WithdrawalRequestRepository } from '../repos/withdrawalRequestRepository.js';
import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import { TokenCredentialProviderUsageRepository } from '../repos/tokenCredentialProviderUsageRepository.js';
import { WalletLedgerRepository } from '../repos/walletLedgerRepository.js';
import { AnalyticsRepository } from '../repos/analyticsRepository.js';
import { AnalyticsDashboardSnapshotRepository } from '../repos/analyticsDashboardSnapshotRepository.js';
import { RequestLogRepository } from '../repos/requestLogRepository.js';
import { PilotIdentityRepository } from '../repos/pilotIdentityRepository.js';
import { PilotAdmissionFreezeRepository } from '../repos/pilotAdmissionFreezeRepository.js';
import { PaymentProfileRepository } from '../repos/paymentProfileRepository.js';
import { PaymentMethodRepository } from '../repos/paymentMethodRepository.js';
import { AutoRechargeSettingsRepository } from '../repos/autoRechargeSettingsRepository.js';
import { PaymentAttemptRepository } from '../repos/paymentAttemptRepository.js';
import { PaymentWebhookEventRepository } from '../repos/paymentWebhookEventRepository.js';
import { OrgAccessRepository } from '../repos/orgAccessRepository.js';
import { OrgInviteRepository } from '../repos/orgInviteRepository.js';
import { OrgBuyerKeyRepository } from '../repos/orgBuyerKeyRepository.js';
import { OrgTokenRepository } from '../repos/orgTokenRepository.js';
import { PaymentOutcomeRepository } from '../repos/paymentOutcomeRepository.js';
import { buildDefaultJobs } from '../jobs/registry.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { KeyPool } from './keyPool.js';
import { RouterEngine } from './routerEngine.js';
import { RoutingService } from './routingService.js';
import { IdempotencyService } from './idempotencyService.js';
import { UsageMeteringWriter } from './metering/usageMeteringWriter.js';
import { EarningsProjectorService } from './earnings/earningsProjectorService.js';
import { WithdrawalService } from './earnings/withdrawalService.js';
import { TokenCredentialService } from './tokenCredentialService.js';
import { PilotSessionService } from './pilot/pilotSessionService.js';
import { PilotGithubAuthService } from './pilot/pilotGithubAuthService.js';
import { PilotCutoverService } from './pilot/pilotCutoverService.js';
import { WalletService } from './wallet/walletService.js';
import { PaymentService } from './payments/paymentService.js';
import { StripeClient } from './payments/stripeClient.js';
import { readPilotGithubCallbackUrl } from './pilot/pilotUrlConfig.js';
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
    walletLedger: new WalletLedgerRepository(sql),
    analytics: new AnalyticsRepository(sql),
    analyticsDashboardSnapshots: new AnalyticsDashboardSnapshotRepository(sql),
    earningsLedger: new EarningsLedgerRepository(sql),
    requestLog: new RequestLogRepository(sql),
    pilotIdentity: new PilotIdentityRepository(sql),
    pilotAdmissionFreezes: new PilotAdmissionFreezeRepository(sql),
    withdrawalRequests: new WithdrawalRequestRepository(sql),
    paymentProfiles: new PaymentProfileRepository(sql),
    paymentMethods: new PaymentMethodRepository(sql),
    autoRechargeSettings: new AutoRechargeSettingsRepository(sql),
    paymentAttempts: new PaymentAttemptRepository(sql),
    paymentWebhookEvents: new PaymentWebhookEventRepository(sql),
    paymentOutcomes: new PaymentOutcomeRepository(sql),
    orgAccess: new OrgAccessRepository(sql),
    orgInvites: new OrgInviteRepository(sql),
    orgBuyerKeys: new OrgBuyerKeyRepository(sql),
    orgTokens: new OrgTokenRepository(sql)
  },
  services: {
    earningsProjector: undefined as unknown as EarningsProjectorService,
    idempotency: undefined as unknown as IdempotencyService,
    jobs: undefined as unknown as JobScheduler,
    keyPool: new KeyPool(),
    metering: undefined as unknown as UsageMeteringWriter,
    pilotCutovers: undefined as unknown as PilotCutoverService,
    pilotGithubAuth: undefined as unknown as PilotGithubAuthService,
    pilotSessions: undefined as unknown as PilotSessionService,
    payments: undefined as unknown as PaymentService,
    routerEngine: new RouterEngine(),
    routingService: undefined as unknown as RoutingService,
    tokenCredentials: undefined as unknown as TokenCredentialService,
    wallets: undefined as unknown as WalletService,
    withdrawals: undefined as unknown as WithdrawalService
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
  callbackUrl: readPilotGithubCallbackUrl(),
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
runtime.services.earningsProjector = new EarningsProjectorService({
  canonicalMeteringRepo: runtime.repos.canonicalMetering,
  earningsLedgerRepo: runtime.repos.earningsLedger,
  meteringProjectorStateRepo: runtime.repos.meteringProjectorStates
});
runtime.services.routingService = new RoutingService(
  runtime.services.keyPool,
  runtime.services.routerEngine
);
runtime.services.tokenCredentials = new TokenCredentialService(
  runtime.repos.tokenCredentials,
  runtime.repos.auditLogs
);
runtime.services.payments = new PaymentService({
  paymentProfiles: runtime.repos.paymentProfiles,
  paymentMethods: runtime.repos.paymentMethods,
  autoRechargeSettings: runtime.repos.autoRechargeSettings,
  paymentAttempts: runtime.repos.paymentAttempts,
  paymentOutcomes: runtime.repos.paymentOutcomes,
  paymentWebhooks: runtime.repos.paymentWebhookEvents,
  stripeClient: new StripeClient({
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  })
});
runtime.services.wallets = new WalletService({
  sql: runtime.sql,
  walletLedgerRepo: runtime.repos.walletLedger,
  canonicalMeteringRepo: runtime.repos.canonicalMetering,
  meteringProjectorStateRepo: runtime.repos.meteringProjectorStates,
  paymentsAdapter: runtime.services.payments
});
runtime.services.withdrawals = new WithdrawalService({
  sql: runtime.sql,
  earningsLedgerRepo: runtime.repos.earningsLedger,
  withdrawalRequestRepo: runtime.repos.withdrawalRequests,
  canonicalMeteringRepo: runtime.repos.canonicalMetering,
  meteringProjectorStateRepo: runtime.repos.meteringProjectorStates
});

export function startBackgroundJobs(): void {
  runtime.services.jobs.start(buildDefaultJobs(runtime.sql));
}
