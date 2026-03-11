/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
import {
  probeAndUpdateTokenCredential,
  readTokenCredentialProbeIntervalHours,
  readTokenCredentialProbeTimeoutMs
} from '../services/tokenCredentialProbe.js';
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
  currency: z.string().length(3).optional()
});

const replayMeteringSchema = z.object({
  action: z.enum(['usage', 'correction', 'reversal']),
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
  authScheme: z.enum(['x_api_key', 'bearer']).default('x_api_key'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  debugLabel: z.string().trim().min(1).max(64).optional(),
  expiresAt: z.string().datetime({ offset: true }),
  monthlyContributionLimitUnits: z.number().int().nonnegative().optional()
});

const tokenCredentialRotateSchema = z.object({
  orgId: z.string().uuid(),
  provider: tokenCredentialProviderSchema,
  authScheme: z.enum(['x_api_key', 'bearer']).default('x_api_key'),
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

const buyerProviderPreferenceUpdateSchema = z.object({
  preferredProvider: buyerProviderPreferenceSchema.nullable()
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

router.post('/v1/admin/replay-metering', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
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
    if (parsed.action === 'usage') {
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
});

router.post('/v1/admin/token-credentials', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = tokenCredentialCreateSchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ body: parsed, apiKeyId: req.auth?.apiKeyId }));
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
        authScheme: parsed.authScheme,
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
    const requestHash = sha256Hex(stableJson({ body: parsed, apiKeyId: req.auth?.apiKeyId }));
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
      authScheme: parsed.authScheme,
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
    if (existing.status !== 'maxed') {
      throw new AppError('invalid_request', 409, 'Token credential must be maxed before manual probe', {
        status: existing.status
      });
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AppError('invalid_request', 409, 'Token credential is expired and cannot be probed');
    }

    const probeOutcome = await probeAndUpdateTokenCredential(runtime.repos.tokenCredentials, existing, {
      timeoutMs: readTokenCredentialProbeTimeoutMs(),
      probeIntervalHours: readTokenCredentialProbeIntervalHours()
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
      nextProbeAt: probeOutcome.nextProbeAt ? probeOutcome.nextProbeAt.toISOString() : null
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
        nextProbeAt: responseBody.nextProbeAt
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
