/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { RequestHistoryCursor } from '../repos/routingAttributionRepository.js';
import { runtime } from '../services/runtime.js';
import {
  readClaudeContributionCapProviderExhaustionHold,
  readClaudeContributionCapSnapshotState
} from '../services/claudeContributionCapState.js';
import {
  type AnthropicOauthUsageRefreshOutcome,
  isAnthropicOauthTokenCredential,
  isTokenCredentialProviderUsageRefreshSupported,
  parkAnthropicOauthCredentialAfterUsageAuthFailure,
  providerUsageWarningReasonFromRefreshOutcome
} from '../services/tokenCredentialProviderUsage.js';
import {
  refreshAnthropicOauthUsageWithCredentialRefresh,
  refreshTokenCredentialProviderUsageWithCredentialRefresh
} from '../services/tokenCredentialOauthRefresh.js';
import {
  probeAndUpdateTokenCredential,
  readTokenCredentialProbeIntervalMinutes,
  readTokenCredentialProbeTimeoutMs
} from '../services/tokenCredentialProbe.js';
import { deriveTokenCredentialAuthDiagnosis } from '../services/tokenCredentialAuthDiagnosis.js';
import { AppError } from '../utils/errors.js';
import { sha256Hex, stableJson } from '../utils/hash.js';
import { readAndValidateIdempotencyKey } from '../utils/idempotencyKey.js';
import { logSensitiveAction } from '../utils/audit.js';
import { resolveDefaultBuyerProvider } from '../utils/providerPreference.js';
import { isMissingBuyerProviderPreferenceColumn } from '../repos/apiKeyRepository.js';

const router = Router();

const tokenCredentialProviderSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(['anthropic', 'openai', 'codex'])
).transform((provider) => (provider === 'codex' ? 'openai' : provider));

type TokenCredentialAuthScheme = 'x_api_key' | 'bearer';

const buyerProviderPreferenceSchema = tokenCredentialProviderSchema;

const killSwitchSchema = z.object({
  scope: z.enum(['seller_key', 'org', 'model', 'global']),
  targetId: z.string().min(1),
  isDisabled: z.boolean(),
  reason: z.string().min(3).max(500)
}).superRefine((value, ctx) => {
  if (value.scope === 'global' && value.targetId !== '*') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetId'],
      message: "global scope requires targetId='*'"
    });
  }
  if (value.scope !== 'global' && value.targetId === '*') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetId'],
      message: "targetId='*' is only valid for global scope"
    });
  }
});

const meteringEventSchema = z.object({
  requestId: z.string().min(1),
  attemptNo: z.number().int().min(1),
  orgId: z.string().uuid(),
  apiKeyId: z.string().uuid().optional(),
  sellerKeyId: z.string().uuid().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usageUnits: z.number().int().nonnegative(),
  retailEquivalentMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).optional(),
  sessionId: z.string().min(1).optional(),
  admissionOrgId: z.string().uuid().optional(),
  admissionCutoverId: z.string().uuid().nullable().optional(),
  admissionRoutingMode: z.enum(['self-free', 'paid-team-capacity', 'team-overflow-on-contributor-capacity']).optional(),
  consumerUserId: z.string().uuid().nullable().optional(),
  teamConsumerId: z.string().min(1).nullable().optional(),
  servingOrgId: z.string().uuid().optional(),
  providerAccountId: z.string().min(1).nullable().optional(),
  tokenCredentialId: z.string().uuid().nullable().optional(),
  capacityOwnerUserId: z.string().uuid().nullable().optional(),
  rateCardVersionId: z.string().uuid().nullable().optional(),
  buyerDebitMinor: z.number().int().optional(),
  contributorEarningsMinor: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const replayMeteringSchema = z.object({
  action: z.enum(['usage', 'served_request_retry', 'correction', 'reversal']),
  sourceEventId: z.string().uuid().optional(),
  note: z.string().min(1).max(500).optional(),
  event: meteringEventSchema
}).superRefine((value, ctx) => {
  if ((value.action === 'correction' || value.action === 'reversal') && !value.sourceEventId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceEventId'],
      message: 'sourceEventId is required for correction/reversal'
    });
  }
});

const tokenCredentialCreateSchema = z.object({
  orgId: z.string().uuid(),
  provider: tokenCredentialProviderSchema,
  authScheme: z.enum(['x_api_key', 'bearer']).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  debugLabel: z.string().trim().min(1).max(64).optional(),
  expiresAt: z.string().datetime({ offset: true }),
  monthlyContributionLimitUnits: z.number().int().nonnegative().optional()
});

const tokenCredentialRotateSchema = z.object({
  orgId: z.string().uuid(),
  provider: tokenCredentialProviderSchema,
  authScheme: z.enum(['x_api_key', 'bearer']).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  debugLabel: z.string().trim().min(1).max(64).optional(),
  expiresAt: z.string().datetime({ offset: true }),
  monthlyContributionLimitUnits: z.number().int().nonnegative().optional(),
  previousCredentialId: z.string().uuid().optional()
});

const tokenCredentialRefreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(1).nullable()
});

const tokenCredentialDebugLabelSchema = z.object({
  debugLabel: z.string().trim().min(1).max(64)
});

const tokenCredentialContributionCapSchema = z.object({
  fiveHourReservePercent: z.number().int().min(0).max(100).optional(),
  sevenDayReservePercent: z.number().int().min(0).max(100).optional()
}).superRefine((value, ctx) => {
  if (value.fiveHourReservePercent === undefined && value.sevenDayReservePercent === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one reserve percent must be provided'
    });
  }
});

const buyerProviderPreferenceUpdateSchema = z.object({
  preferredProvider: buyerProviderPreferenceSchema.nullable()
});

const adminPilotSessionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('self'),
    effectiveOrgId: z.string().min(1).optional(),
    effectiveOrgSlug: z.string().min(1).optional(),
    effectiveOrgName: z.string().min(1).optional()
  }),
  z.object({
    mode: z.literal('impersonation'),
    targetUserId: z.string().min(1),
    targetOrgId: z.string().min(1),
    targetOrgSlug: z.string().min(1).optional(),
    targetOrgName: z.string().min(1).optional(),
    githubLogin: z.string().min(1).optional(),
    userEmail: z.string().email().optional()
  })
]);

const adminPilotCutoverSchema = z.object({
  sourceOrgId: z.string().min(1),
  targetOrgSlug: z.string().min(1),
  targetOrgName: z.string().min(1),
  targetUserEmail: z.string().email(),
  targetUserDisplayName: z.string().min(1).optional(),
  buyerKeyIds: z.array(z.string().min(1)),
  tokenCredentialIds: z.array(z.string().min(1)),
  effectiveAt: z.string().datetime({ offset: true }).optional()
});

const adminPilotRollbackSchema = z.object({
  sourceCutoverId: z.string().min(1).optional(),
  targetOrgId: z.string().min(1),
  buyerKeyIds: z.array(z.string().min(1)),
  tokenCredentialIds: z.array(z.string().min(1)),
  effectiveAt: z.string().datetime({ offset: true }).optional()
});

const adminRequestHistoryQuerySchema = z.object({
  consumerOrgId: z.string().uuid().optional(),
  historyScope: z.enum(['post_cutover', 'all']).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional()
});

const adminUnfinalizedRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
});

const requestHistoryCursorSchema = z.object({
  createdAt: z.string().min(1),
  requestId: z.string().min(1),
  attemptNo: z.number().int().min(1)
});

const rateCardLineItemSchema = z.object({
  provider: tokenCredentialProviderSchema,
  modelPattern: z.string().min(1),
  routingMode: z.enum(['self-free', 'paid-team-capacity', 'team-overflow-on-contributor-capacity']),
  buyerDebitMinorPerUnit: z.number().int(),
  contributorEarningsMinorPerUnit: z.number().int(),
  currency: z.string().length(3).optional()
});

const createRateCardVersionSchema = z.object({
  versionKey: z.string().min(1).max(128),
  effectiveAt: z.string().datetime({ offset: true }),
  lineItems: z.array(rateCardLineItemSchema).min(1)
});

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '23505';
}

function canAccessBuyerKey(input: {
  adminOrgId: string | null | undefined;
  buyerOrgId: string | null;
}): boolean {
  const { adminOrgId, buyerOrgId } = input;
  if (!buyerOrgId) return false;
  if (!adminOrgId) return true;
  return adminOrgId === buyerOrgId;
}

function isAnthropicOauthAccessToken(provider: string, accessToken: string): boolean {
  return provider === 'anthropic' && accessToken.includes('sk-ant-oat');
}

function encodeHistoryCursor(cursor: RequestHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeHistoryCursor(cursor: string | undefined): RequestHistoryCursor | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return requestHistoryCursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppError('invalid_request', 400, 'Invalid request-history cursor');
  }
}

function resolveTokenCredentialAuthScheme(input: {
  provider: string;
  accessToken: string;
  authScheme?: TokenCredentialAuthScheme;
}): TokenCredentialAuthScheme {
  if (input.authScheme) {
    return input.authScheme;
  }

  if (isAnthropicOauthAccessToken(input.provider, input.accessToken)) {
    return 'bearer';
  }

  return 'x_api_key';
}

router.get('/v1/admin/pool-health', requireApiKey(runtime.repos.apiKeys, ['admin']), async (_req, res, next) => {
  try {
    const byStatus = await runtime.repos.sellerKeys.statusCounts();
    const totalKeys = Object.values(byStatus).reduce((sum, value) => sum + value, 0);

    res.json({
      totalKeys,
      byStatus,
      totalQueueDepth: 0,
      orgQueues: {}
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/pilot/session', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const parsed = adminPilotSessionSchema.parse(req.body);
    const session = parsed.mode === 'self'
      ? {
        sessionKind: 'admin_self' as const,
        actorUserId: null,
        actorApiKeyId: req.auth?.apiKeyId ?? null,
        actorOrgId: req.auth?.orgId ?? null,
        effectiveOrgId: parsed.effectiveOrgId ?? req.auth?.orgId ?? '',
        effectiveOrgSlug: parsed.effectiveOrgSlug ?? null,
        effectiveOrgName: parsed.effectiveOrgName ?? null,
        githubLogin: null,
        userEmail: null,
        impersonatedUserId: null
      }
      : {
        sessionKind: 'admin_impersonation' as const,
        actorUserId: null,
        actorApiKeyId: req.auth?.apiKeyId ?? null,
        actorOrgId: req.auth?.orgId ?? null,
        effectiveOrgId: parsed.targetOrgId,
        effectiveOrgSlug: parsed.targetOrgSlug ?? null,
        effectiveOrgName: parsed.targetOrgName ?? null,
        githubLogin: parsed.githubLogin ?? null,
        userEmail: parsed.userEmail ?? null,
        impersonatedUserId: parsed.targetUserId
      };

    const sessionToken = runtime.services.pilotSessions.issueSession(session);
    res.setHeader('set-cookie', `innies_pilot_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`);
    res.status(200).json({
      ok: true,
      sessionToken,
      session
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/pilot/cutover', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const parsed = adminPilotCutoverSchema.parse(req.body);
    const result = await runtime.services.pilotCutovers.cutover({
      sourceOrgId: parsed.sourceOrgId,
      targetOrgSlug: parsed.targetOrgSlug,
      targetOrgName: parsed.targetOrgName,
      targetUserEmail: parsed.targetUserEmail,
      targetUserDisplayName: parsed.targetUserDisplayName,
      buyerKeyIds: parsed.buyerKeyIds,
      tokenCredentialIds: parsed.tokenCredentialIds,
      actorUserId: null,
      effectiveAt: parsed.effectiveAt ? new Date(parsed.effectiveAt) : undefined
    });

    res.status(200).json({
      ok: true,
      cutoverId: result.cutoverRecord.id,
      targetOrgId: result.targetOrgId,
      targetUserId: result.targetUserId
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/pilot/rollback', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const parsed = adminPilotRollbackSchema.parse(req.body);
    const result = await runtime.services.pilotCutovers.rollback({
      sourceCutoverId: parsed.sourceCutoverId,
      targetOrgId: parsed.targetOrgId,
      buyerKeyIds: parsed.buyerKeyIds,
      tokenCredentialIds: parsed.tokenCredentialIds,
      actorUserId: null,
      effectiveAt: parsed.effectiveAt ? new Date(parsed.effectiveAt) : undefined
    });

    res.status(200).json({
      ok: true,
      rollbackId: result.rollbackRecord.id
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/admin/buyer-keys/:id/provider-preference', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const record = await runtime.repos.apiKeys.getBuyerProviderPreference(id);
    if (!record || record.scope !== 'buyer_proxy') {
      throw new AppError('invalid_request', 404, 'Buyer key not found');
    }
    if (!canAccessBuyerKey({ adminOrgId: req.auth?.orgId, buyerOrgId: record.org_id })) {
      throw new AppError('forbidden', 403, 'Cannot access buyer key outside admin org scope');
    }

    const defaultProvider = resolveDefaultBuyerProvider();
    const preferredProvider = record.preferred_provider ?? null;
    const effectiveProvider = preferredProvider ?? defaultProvider;

    res.status(200).json({
      ok: true,
      apiKeyId: record.id,
      orgId: record.org_id,
      preferredProvider,
      effectiveProvider,
      source: preferredProvider ? 'explicit' : 'default',
      updatedAt: record.provider_preference_updated_at
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/v1/admin/buyer-keys/:id/provider-preference', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const parsed = buyerProviderPreferenceUpdateSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ id, body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_buyer_provider_preference_update_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const existing = await runtime.repos.apiKeys.getBuyerProviderPreference(id);
    if (!existing || existing.scope !== 'buyer_proxy') {
      throw new AppError('invalid_request', 404, 'Buyer key not found');
    }
    if (!canAccessBuyerKey({ adminOrgId: req.auth?.orgId, buyerOrgId: existing.org_id })) {
      throw new AppError('forbidden', 403, 'Cannot access buyer key outside admin org scope');
    }

    let updated: boolean;
    try {
      updated = await runtime.repos.apiKeys.setBuyerProviderPreference({
        id,
        preferredProvider: parsed.preferredProvider
      });
    } catch (error) {
      if (isMissingBuyerProviderPreferenceColumn(error)) {
        throw new AppError('conflict', 409, 'Buyer provider preference migration not applied');
      }
      throw error;
    }
    if (!updated) {
      throw new AppError('invalid_request', 404, 'Buyer key not found');
    }

    const defaultProvider = resolveDefaultBuyerProvider();
    const effectiveProvider = parsed.preferredProvider ?? defaultProvider;
    const responseBody = {
      ok: true,
      apiKeyId: id,
      orgId: existing.org_id,
      preferredProvider: parsed.preferredProvider,
      effectiveProvider,
      source: parsed.preferredProvider ? 'explicit' : 'default'
    } as const;

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      action: 'buyer_key.provider_preference.update',
      targetType: 'api_key',
      targetId: id,
      orgId: existing.org_id,
      metadata: {
        preferredProvider: parsed.preferredProvider,
        effectiveProvider
      }
    });

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/kill-switch', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = killSwitchSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_kill_switch_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }

      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const event = await runtime.repos.killSwitch.createEvent({
      scope: parsed.scope,
      targetId: parsed.targetId,
      isDisabled: parsed.isDisabled,
      reason: parsed.reason
    });

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      action: 'admin.kill_switch.set',
      targetType: parsed.scope,
      targetId: parsed.targetId,
      metadata: {
        isDisabled: parsed.isDisabled,
        reason: parsed.reason
      }
    });

    const responseBody = {
      ok: true,
      id: event.id,
      scope: parsed.scope,
      targetId: parsed.targetId,
      isDisabled: parsed.isDisabled
    };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: event.id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

async function handleAdminReplayMetering(req: any, res: any, next: (error?: unknown) => void): Promise<void> {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = replayMeteringSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_replay_metering_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    let saved;
    if (parsed.action === 'usage' || parsed.action === 'served_request_retry') {
      saved = await runtime.services.metering.recordUsage(parsed.event);
    } else if (parsed.action === 'correction') {
      saved = await runtime.services.metering.recordCorrection(parsed.sourceEventId!, parsed.event, parsed.note ?? 'manual replay correction');
    } else {
      saved = await runtime.services.metering.recordReversal(parsed.sourceEventId!, parsed.event, parsed.note ?? 'manual replay reversal');
    }

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      action: 'admin.replay_metering.create',
      targetType: 'usage_ledger',
      targetId: saved.id,
      metadata: {
        replayAction: parsed.action,
        sourceEventId: parsed.sourceEventId ?? null,
        requestId: parsed.event.requestId,
        attemptNo: parsed.event.attemptNo
      }
    });

    const responseBody = {
      ok: true,
      id: saved.id,
      entryType: saved.entry_type
    };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: saved.id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
}

router.post('/v1/admin/replay-metering', requireApiKey(runtime.repos.apiKeys, ['admin']), handleAdminReplayMetering);

router.post('/v1/admin/metering/corrections', requireApiKey(runtime.repos.apiKeys, ['admin']), handleAdminReplayMetering);

router.get('/v1/admin/requests', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const query = adminRequestHistoryQuerySchema.parse(req.query);
    const cursor = decodeHistoryCursor(query.cursor);
    const rows = await runtime.repos.routingAttribution.listAdminRequestHistory({
      consumerOrgId: query.consumerOrgId,
      limit: query.limit,
      cursor,
      historyScope: query.historyScope
    });
    const last = rows[rows.length - 1];
    res.json({
      requests: rows,
      nextCursor: rows.length === query.limit && last ? encodeHistoryCursor({
        createdAt: last.created_at,
        requestId: last.request_id,
        attemptNo: last.attempt_no
      }) : null
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/admin/requests/:requestId/explanation', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const requestId = z.string().min(1).parse(req.params.requestId);
    const explanation = await runtime.repos.routingAttribution.getRequestExplanation(requestId);
    if (!explanation) {
      throw new AppError('not_found', 404, 'Request explanation not found');
    }
    res.json({
      ok: true,
      request: explanation
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/admin/requests/unfinalized', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const query = adminUnfinalizedRequestsQuerySchema.parse(req.query);
    const requests = await runtime.repos.routingAttribution.listFinanciallyUnfinalizedRequests(query.limit);
    res.json({
      requests
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/admin/rate-cards', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const versions = await runtime.repos.rateCards.listVersions(20);
    res.json({
      versions
    });
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/rate-cards', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const parsed = createRateCardVersionSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;
    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_rate_cards_create_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const { version, lineItems } = await runtime.repos.rateCards.createVersionWithLineItems({
      versionKey: parsed.versionKey,
      effectiveAt: new Date(parsed.effectiveAt),
      lineItems: parsed.lineItems
    });

    const responseBody = {
      ok: true,
      version,
      lineItems
    };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: version.id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = tokenCredentialCreateSchema.parse(req.body);
    const authScheme = resolveTokenCredentialAuthScheme(parsed);
    const normalizedBody = { ...parsed, authScheme };
    const requestHash = sha256Hex(stableJson({ body: normalizedBody, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;
    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_create_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    let created;
    try {
      created = await runtime.services.tokenCredentials.create({
        orgId: parsed.orgId,
        provider: parsed.provider,
        authScheme,
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken ?? null,
        debugLabel: parsed.debugLabel ?? null,
        expiresAt: new Date(parsed.expiresAt),
        monthlyContributionLimitUnits: parsed.monthlyContributionLimitUnits ?? null
      }, {
        actorApiKeyId: req.auth?.apiKeyId ?? null
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          'invalid_request',
          409,
          'Token credential write conflict. Retry with a new Idempotency-Key.'
        );
      }
      throw error;
    }

    const responseBody = {
      ok: true,
      id: created.id,
      rotationVersion: created.rotationVersion
    };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: created.id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials/rotate', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = tokenCredentialRotateSchema.parse(req.body);
    const authScheme = resolveTokenCredentialAuthScheme(parsed);
    const normalizedBody = { ...parsed, authScheme };
    const requestHash = sha256Hex(stableJson({ body: normalizedBody, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;
    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_rotate_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const rotated = await runtime.services.tokenCredentials.rotate({
      orgId: parsed.orgId,
      provider: parsed.provider,
      authScheme,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
      debugLabel: parsed.debugLabel ?? null,
      expiresAt: new Date(parsed.expiresAt),
      monthlyContributionLimitUnits: parsed.monthlyContributionLimitUnits ?? null,
      previousCredentialId: parsed.previousCredentialId ?? null
    }, {
      actorApiKeyId: req.auth?.apiKeyId ?? null
    });

    const responseBody = {
      ok: true,
      id: rotated.id,
      previousId: rotated.previousId,
      rotationVersion: rotated.rotationVersion
    };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: rotated.id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials/:id/revoke', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const requestHash = sha256Hex(stableJson({ id, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_revoke_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const existing = await runtime.repos.tokenCredentials.getById(id);
    if (!existing) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const revoked = await runtime.services.tokenCredentials.revoke(id, existing.orgId, {
      actorApiKeyId: req.auth?.apiKeyId ?? null
    });
    const responseBody = { ok: true, id, revoked };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials/:id/pause', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const requestHash = sha256Hex(stableJson({ id, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_pause_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const paused = await runtime.services.tokenCredentials.pause(id, {
      actorApiKeyId: req.auth?.apiKeyId ?? null
    });
    if (!paused) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const responseBody = {
      ok: true,
      id,
      orgId: paused.orgId,
      provider: paused.provider,
      debugLabel: paused.debugLabel,
      status: paused.status,
      changed: paused.changed
    } as const;

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials/:id/unpause', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const requestHash = sha256Hex(stableJson({ id, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_unpause_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const unpaused = await runtime.services.tokenCredentials.unpause(id, {
      actorApiKeyId: req.auth?.apiKeyId ?? null
    });
    if (!unpaused) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const responseBody = {
      ok: true,
      id,
      orgId: unpaused.orgId,
      provider: unpaused.provider,
      debugLabel: unpaused.debugLabel,
      status: unpaused.status,
      changed: unpaused.changed
    } as const;

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.patch('/v1/admin/token-credentials/:id/label', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const parsed = tokenCredentialDebugLabelSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ id, body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_label_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const updated = await runtime.services.tokenCredentials.updateDebugLabel(
      id,
      parsed.debugLabel,
      { actorApiKeyId: req.auth?.apiKeyId ?? null }
    );
    if (!updated) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const responseBody = {
      ok: true,
      id,
      orgId: updated.orgId,
      provider: updated.provider,
      debugLabel: updated.debugLabel,
      changed: updated.changed
    } as const;

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.patch('/v1/admin/token-credentials/:id/refresh-token', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const parsed = tokenCredentialRefreshTokenSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ id, body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_refresh_token_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const existing = await runtime.repos.tokenCredentials.getById(id);
    if (!existing) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const updated = await runtime.services.tokenCredentials.setRefreshToken(
      id,
      existing.orgId,
      parsed.refreshToken,
      { actorApiKeyId: req.auth?.apiKeyId ?? null }
    );
    if (!updated) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const responseBody = {
      ok: true,
      id,
      hasRefreshToken: parsed.refreshToken !== null
    };

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.get('/v1/admin/token-credentials/:id/contribution-cap', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const credential = await runtime.repos.tokenCredentials.getById(id);
    if (!credential) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    res.json({
      ok: true,
      id,
      provider: credential.provider,
      orgId: credential.orgId,
      fiveHourReservePercent: credential.fiveHourReservePercent,
      sevenDayReservePercent: credential.sevenDayReservePercent
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/v1/admin/token-credentials/:id/contribution-cap', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const parsed = tokenCredentialContributionCapSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ id, body: parsed, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_contribution_cap_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const updated = await runtime.services.tokenCredentials.updateContributionCap(
      id,
      {
        fiveHourReservePercent: parsed.fiveHourReservePercent,
        sevenDayReservePercent: parsed.sevenDayReservePercent
      },
      { actorApiKeyId: req.auth?.apiKeyId ?? null }
    );
    if (!updated) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }

    const responseBody = {
      ok: true,
      id,
      provider: updated.provider,
      orgId: updated.orgId,
      fiveHourReservePercent: updated.fiveHourReservePercent,
      sevenDayReservePercent: updated.sevenDayReservePercent
    } as const;

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials/:id/probe', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const requestHash = sha256Hex(stableJson({ id, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_probe_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const existing = await runtime.repos.tokenCredentials.getById(id);
    if (!existing) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }
    if (existing.status !== 'active' && existing.status !== 'maxed') {
      throw new AppError('invalid_request', 409, 'Token credential must be active or maxed before manual probe', {
        status: existing.status
      });
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AppError('invalid_request', 409, 'Token credential is expired and cannot be probed');
    }

    const probeOutcome = await probeAndUpdateTokenCredential(runtime.repos.tokenCredentials, existing, {
      timeoutMs: readTokenCredentialProbeTimeoutMs(),
      probeIntervalMinutes: readTokenCredentialProbeIntervalMinutes()
    });
    const authDiagnosis = probeOutcome.ok || probeOutcome.authValid === true
      ? {
          authDiagnosis: null,
          accessTokenExpiresAt: null,
          refreshTokenState: null
        }
      : deriveTokenCredentialAuthDiagnosis({
          provider: existing.provider,
          accessToken: existing.accessToken,
          hasRefreshToken: existing.refreshToken !== null,
          statusCode: probeOutcome.statusCode,
          reason: probeOutcome.reason
        });

    const responseBody = {
      ok: true,
      id,
      provider: existing.provider,
      debugLabel: existing.debugLabel,
      probeOk: probeOutcome.ok,
      reactivated: probeOutcome.reactivated,
      status: probeOutcome.status,
      upstreamStatus: probeOutcome.statusCode,
      reason: probeOutcome.reason,
      nextProbeAt: probeOutcome.nextProbeAt ? probeOutcome.nextProbeAt.toISOString() : null,
      ...(probeOutcome.authValid !== undefined ? { authValid: probeOutcome.authValid } : {}),
      ...(probeOutcome.availabilityOk !== undefined ? { availabilityOk: probeOutcome.availabilityOk } : {}),
      ...(probeOutcome.usageExhausted !== undefined ? { usageExhausted: probeOutcome.usageExhausted } : {}),
      ...(probeOutcome.usageExhaustedWindow !== undefined ? { usageExhaustedWindow: probeOutcome.usageExhaustedWindow } : {}),
      ...(probeOutcome.usageResetAt !== undefined
        ? { usageResetAt: probeOutcome.usageResetAt ? probeOutcome.usageResetAt.toISOString() : null }
        : {}),
      ...(probeOutcome.refreshAttempted !== undefined ? { refreshAttempted: probeOutcome.refreshAttempted } : {}),
      ...(probeOutcome.refreshSucceeded !== undefined ? { refreshSucceeded: probeOutcome.refreshSucceeded } : {}),
      ...(probeOutcome.refreshReason !== undefined ? { refreshReason: probeOutcome.refreshReason } : {}),
      ...(probeOutcome.refreshedCredential !== undefined ? { refreshedCredential: probeOutcome.refreshedCredential } : {}),
      ...(authDiagnosis.authDiagnosis !== null ? { authDiagnosis: authDiagnosis.authDiagnosis } : {}),
      ...(authDiagnosis.accessTokenExpiresAt !== null ? { accessTokenExpiresAt: authDiagnosis.accessTokenExpiresAt } : {}),
      ...(authDiagnosis.refreshTokenState !== null ? { refreshTokenState: authDiagnosis.refreshTokenState } : {})
    } as const;

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      action: 'token_credential.probe',
      targetType: 'token_credential',
      targetId: id,
      orgId: existing.orgId,
      metadata: {
        provider: existing.provider,
        debugLabel: existing.debugLabel,
        probeOk: probeOutcome.ok,
        reactivated: probeOutcome.reactivated,
        status: probeOutcome.status,
        upstreamStatus: probeOutcome.statusCode,
        reason: probeOutcome.reason,
        nextProbeAt: responseBody.nextProbeAt,
        authValid: probeOutcome.authValid,
        availabilityOk: probeOutcome.availabilityOk,
        usageExhausted: probeOutcome.usageExhausted,
        usageExhaustedWindow: probeOutcome.usageExhaustedWindow,
        usageResetAt: responseBody.usageResetAt,
        refreshAttempted: probeOutcome.refreshAttempted,
        refreshSucceeded: probeOutcome.refreshSucceeded,
        refreshReason: probeOutcome.refreshReason,
        refreshedCredential: probeOutcome.refreshedCredential,
        authDiagnosis: authDiagnosis.authDiagnosis,
        accessTokenExpiresAt: authDiagnosis.accessTokenExpiresAt,
        refreshTokenState: authDiagnosis.refreshTokenState
      }
    });

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.post('/v1/admin/token-credentials/:id/provider-usage-refresh', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);
    const requestHash = sha256Hex(stableJson({ id, apiKeyId: req.auth?.apiKeyId }));
    const tenantScope = req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`;

    const idemStart = await runtime.services.idempotency.start({
      scope: 'admin_token_credentials_provider_usage_refresh_v1',
      tenantScope,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) {
        throw new AppError('idempotency_replay_unavailable', 409, 'Idempotent replay not available for this request');
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const existing = await runtime.repos.tokenCredentials.getById(id);
    if (!existing) {
      throw new AppError('invalid_request', 404, 'Token credential not found');
    }
    if (existing.status === 'revoked') {
      throw new AppError('invalid_request', 409, 'Revoked token credential cannot refresh provider usage');
    }
    const isAnthropicOauthCredential = isAnthropicOauthTokenCredential(existing);
    if (!isTokenCredentialProviderUsageRefreshSupported(existing)) {
      throw new AppError(
        'invalid_request',
        409,
        'Provider usage refresh is only supported for Anthropic OAuth and OpenAI/Codex OAuth or session credentials',
        {
          provider: existing.provider,
          status: existing.status
        }
      );
    }
    const expiredAtRequestStart = existing.status === 'expired' || existing.expiresAt.getTime() <= Date.now();
    if (expiredAtRequestStart && !existing.refreshToken) {
      throw new AppError(
        'invalid_request',
        409,
        'Expired token credential cannot refresh provider usage without a stored refresh token'
      );
    }

    const refreshedUsage = isAnthropicOauthCredential
      ? await refreshAnthropicOauthUsageWithCredentialRefresh(
        runtime.repos.tokenCredentialProviderUsage,
        runtime.repos.tokenCredentials,
        existing,
        { ignoreRetryBackoff: true }
      )
      : await refreshTokenCredentialProviderUsageWithCredentialRefresh(
        runtime.repos.tokenCredentialProviderUsage,
        runtime.repos.tokenCredentials,
        existing,
        { ignoreRetryBackoff: true }
      );
    const effectiveCredential = refreshedUsage.credential;
    const refreshOutcome = refreshedUsage.outcome;
    const authFailureStatusCode = !refreshOutcome.ok
      && (refreshOutcome.statusCode === 401 || refreshOutcome.statusCode === 403)
      ? refreshOutcome.statusCode
      : null;
    const shouldParkAfterAuthFailure = authFailureStatusCode !== null && existing.status !== 'expired';
    const nextProbeAt = shouldParkAfterAuthFailure
      ? new Date(Date.now() + (readTokenCredentialProbeIntervalMinutes() * 60 * 1000))
      : null;
    const parkedOutcome = shouldParkAfterAuthFailure
      ? await parkAnthropicOauthCredentialAfterUsageAuthFailure(runtime.repos.tokenCredentials, effectiveCredential, {
        statusCode: authFailureStatusCode,
        nextProbeAt: nextProbeAt!,
        reason: `upstream_${authFailureStatusCode}_provider_usage_refresh`
      })
      : null;
    const anthropicRefreshOutcome = isAnthropicOauthCredential
      ? refreshOutcome as AnthropicOauthUsageRefreshOutcome
      : null;
    const warningReason = anthropicRefreshOutcome !== null && authFailureStatusCode === null
      ? providerUsageWarningReasonFromRefreshOutcome(anthropicRefreshOutcome)
      : null;
    const stateSyncErrors: string[] = [];
    let lifecycle = isAnthropicOauthCredential
      ? {
        fiveHourTransition: null as 'exhausted' | 'cleared' | null,
        sevenDayTransition: null as 'exhausted' | 'cleared' | null
      }
      : null;
    let authValid: boolean | null = refreshOutcome.ok ? true : (authFailureStatusCode !== null ? false : null);
    let availabilityOk: boolean | null = refreshOutcome.ok;
    let usageExhausted = false;
    let usageExhaustedWindow: '5h' | '7d' | 'unknown' | null = null;
    let usageResetAt: string | null = null;
    let reactivated = false;
    let snapshotSummary: {
      usageSource: string;
      fetchedAt: string;
      fiveHourUtilizationRatio: number;
      fiveHourUsedPercent: number;
      fiveHourResetsAt: string | null;
      fiveHourContributionCapExhausted: boolean | null;
      fiveHourProviderUsageExhausted: boolean;
      sevenDayUtilizationRatio: number;
      sevenDayUsedPercent: number;
      sevenDayResetsAt: string | null;
      sevenDayContributionCapExhausted: boolean | null;
      sevenDayProviderUsageExhausted: boolean;
    } | null = null;

    if (isAnthropicOauthCredential && (refreshOutcome.ok || warningReason !== null)) {
      try {
        await runtime.repos.tokenCredentials.setProviderUsageWarning(id, refreshOutcome.ok ? null : warningReason);
      } catch (error) {
        stateSyncErrors.push(error instanceof Error ? error.message : 'provider_usage_warning_sync_failed');
      }
    }

    if (refreshOutcome.ok) {
      if (isAnthropicOauthCredential) {
        const state = readClaudeContributionCapSnapshotState({
          credential: effectiveCredential,
          snapshot: refreshOutcome.snapshot
        });

        snapshotSummary = {
          usageSource: refreshOutcome.snapshot.usageSource,
          fetchedAt: refreshOutcome.snapshot.fetchedAt.toISOString(),
          fiveHourUtilizationRatio: refreshOutcome.snapshot.fiveHourUtilizationRatio,
          fiveHourUsedPercent: refreshOutcome.snapshot.fiveHourUtilizationRatio * 100,
          fiveHourResetsAt: refreshOutcome.snapshot.fiveHourResetsAt?.toISOString() ?? null,
          fiveHourContributionCapExhausted: state.fiveHourContributionCapExhausted,
          fiveHourProviderUsageExhausted: refreshOutcome.snapshot.fiveHourUtilizationRatio >= 1,
          sevenDayUtilizationRatio: refreshOutcome.snapshot.sevenDayUtilizationRatio,
          sevenDayUsedPercent: refreshOutcome.snapshot.sevenDayUtilizationRatio * 100,
          sevenDayResetsAt: refreshOutcome.snapshot.sevenDayResetsAt?.toISOString() ?? null,
          sevenDayContributionCapExhausted: state.sevenDayContributionCapExhausted,
          sevenDayProviderUsageExhausted: refreshOutcome.snapshot.sevenDayUtilizationRatio >= 1
        };

        if (
          state.fetchedAt !== null
          && state.fiveHourUtilizationRatio !== null
          && state.sevenDayUtilizationRatio !== null
          && state.fiveHourSharedThresholdPercent !== null
          && state.sevenDaySharedThresholdPercent !== null
        ) {
          try {
            lifecycle = await runtime.repos.tokenCredentials.syncClaudeContributionCapLifecycle({
              id: effectiveCredential.id,
              orgId: effectiveCredential.orgId,
              provider: effectiveCredential.provider,
              snapshotFetchedAt: state.fetchedAt,
              fiveHourReservePercent: state.fiveHourReservePercent,
              fiveHourUtilizationRatio: state.fiveHourUtilizationRatio,
              fiveHourResetsAt: state.fiveHourResetsAt,
              fiveHourSharedThresholdPercent: state.fiveHourSharedThresholdPercent,
              fiveHourContributionCapExhausted: state.fiveHourContributionCapExhausted,
              sevenDayReservePercent: state.sevenDayReservePercent,
              sevenDayUtilizationRatio: state.sevenDayUtilizationRatio,
              sevenDayResetsAt: state.sevenDayResetsAt,
              sevenDaySharedThresholdPercent: state.sevenDaySharedThresholdPercent,
              sevenDayContributionCapExhausted: state.sevenDayContributionCapExhausted
            });
          } catch (error) {
            stateSyncErrors.push(error instanceof Error ? error.message : 'contribution_cap_lifecycle_sync_failed');
          }
        }

        const providerExhaustionHold = readClaudeContributionCapProviderExhaustionHold({
          credential: effectiveCredential,
          snapshot: refreshOutcome.snapshot
        });
        if (providerExhaustionHold.hasActiveHold) {
          usageExhausted = true;
          usageExhaustedWindow = providerExhaustionHold.reason === 'usage_exhausted_5h' ? '5h' : '7d';
          usageResetAt = providerExhaustionHold.nextRefreshAt?.toISOString() ?? null;
          availabilityOk = false;
        } else if (state.fiveHourContributionCapExhausted || state.sevenDayContributionCapExhausted) {
          availabilityOk = false;
        }
      } else {
        snapshotSummary = {
          usageSource: refreshOutcome.snapshot.usageSource,
          fetchedAt: refreshOutcome.snapshot.fetchedAt.toISOString(),
          fiveHourUtilizationRatio: refreshOutcome.snapshot.fiveHourUtilizationRatio,
          fiveHourUsedPercent: refreshOutcome.snapshot.fiveHourUtilizationRatio * 100,
          fiveHourResetsAt: refreshOutcome.snapshot.fiveHourResetsAt?.toISOString() ?? null,
          fiveHourContributionCapExhausted: null,
          fiveHourProviderUsageExhausted: refreshOutcome.snapshot.fiveHourUtilizationRatio >= 1,
          sevenDayUtilizationRatio: refreshOutcome.snapshot.sevenDayUtilizationRatio,
          sevenDayUsedPercent: refreshOutcome.snapshot.sevenDayUtilizationRatio * 100,
          sevenDayResetsAt: refreshOutcome.snapshot.sevenDayResetsAt?.toISOString() ?? null,
          sevenDayContributionCapExhausted: null,
          sevenDayProviderUsageExhausted: refreshOutcome.snapshot.sevenDayUtilizationRatio >= 1
        };

        if (refreshOutcome.snapshot.fiveHourUtilizationRatio >= 1) {
          usageExhausted = true;
          usageExhaustedWindow = '5h';
          usageResetAt = refreshOutcome.snapshot.fiveHourResetsAt?.toISOString() ?? null;
          availabilityOk = false;
        } else if (refreshOutcome.snapshot.sevenDayUtilizationRatio >= 1) {
          usageExhausted = true;
          usageExhaustedWindow = '7d';
          usageResetAt = refreshOutcome.snapshot.sevenDayResetsAt?.toISOString() ?? null;
          availabilityOk = false;
        }
      }

      if (existing.status === 'maxed') {
        if (availabilityOk) {
          reactivated = await runtime.repos.tokenCredentials.reactivateFromMaxed(effectiveCredential.id);
        } else if (usageExhausted && usageResetAt) {
          await runtime.repos.tokenCredentials.markProbeFailure(
            effectiveCredential.id,
            new Date(usageResetAt),
            `usage_exhausted_${usageExhaustedWindow}`
          );
        }
      }
    }

    const topLevelReason = refreshOutcome.ok
      ? (usageExhausted ? `usage_exhausted_${usageExhaustedWindow}` : 'ok')
      : refreshOutcome.reason;
    const computedNextProbeAt = nextProbeAt?.toISOString()
      ?? (existing.status === 'maxed' && usageExhausted ? usageResetAt : null);

    const responseBody = {
      ok: true,
      id,
      provider: effectiveCredential.provider,
      debugLabel: effectiveCredential.debugLabel,
      status: parkedOutcome?.status ?? (reactivated ? 'active' : effectiveCredential.status),
      refreshOk: refreshOutcome.ok,
      reactivated,
      upstreamStatus: refreshOutcome.ok ? 200 : refreshOutcome.statusCode,
      reason: topLevelReason,
      category: refreshOutcome.ok ? null : refreshOutcome.category,
      warningReason,
      nextProbeAt: computedNextProbeAt,
      authValid,
      availabilityOk,
      usageExhausted,
      usageExhaustedWindow,
      usageResetAt,
      retryAfterMs: !refreshOutcome.ok && 'retryAfterMs' in refreshOutcome
        ? (refreshOutcome.retryAfterMs ?? null)
        : null,
      errorMessage: refreshOutcome.ok ? null : (refreshOutcome.errorMessage ?? null),
      reserve: isAnthropicOauthCredential
        ? {
          fiveHourReservePercent: effectiveCredential.fiveHourReservePercent,
          sevenDayReservePercent: effectiveCredential.sevenDayReservePercent
        }
        : null,
      snapshot: snapshotSummary,
      lifecycle,
      rawPayload: refreshOutcome.rawPayload ?? null,
      stateSyncErrors
    } as const;

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      action: 'token_credential.provider_usage_refresh',
      targetType: 'token_credential',
      targetId: id,
      orgId: effectiveCredential.orgId,
      metadata: {
        provider: effectiveCredential.provider,
        debugLabel: effectiveCredential.debugLabel,
        refreshOk: refreshOutcome.ok,
        reactivated,
        upstreamStatus: responseBody.upstreamStatus,
        reason: responseBody.reason,
        category: responseBody.category,
        warningReason: responseBody.warningReason,
        nextProbeAt: responseBody.nextProbeAt,
        authValid: responseBody.authValid,
        availabilityOk: responseBody.availabilityOk,
        usageExhausted: responseBody.usageExhausted,
        usageExhaustedWindow: responseBody.usageExhaustedWindow,
        usageResetAt: responseBody.usageResetAt,
        stateSyncErrors: responseBody.stateSyncErrors
      }
    });

    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

export default router;
