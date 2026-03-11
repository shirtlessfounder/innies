/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';
import { sha256Hex, stableJson } from '../utils/hash.js';
import { readAndValidateIdempotencyKey } from '../utils/idempotencyKey.js';
import { logSensitiveAction } from '../utils/audit.js';

const router = Router();

const createSellerKeySchema = z.object({
  orgId: z.string().uuid(),
  provider: z.string().min(1),
  providerAccountLabel: z.string().max(200).optional(),
  secret: z.string().min(8),
  encryptionKeyId: z.string().min(1),
  monthlyCapacityLimitUnits: z.number().int().nonnegative().optional(),
  priorityWeight: z.number().int().nonnegative().optional()
});

const updateSellerKeySchema = z.object({
  status: z.enum(['active', 'paused', 'quarantined', 'invalid', 'revoked']).optional(),
  monthlyCapacityLimitUnits: z.number().int().nonnegative().nullable().optional(),
  priorityWeight: z.number().int().nonnegative().optional()
});

router.post('/v1/seller-keys', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = createSellerKeySchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ body: { ...parsed, secret: '__redacted__' } }));

    const idemStart = await runtime.services.idempotency.start({
      scope: 'seller_keys_create_v1',
      tenantScope: req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) throw new AppError('idempotency_replay_unavailable', 409, 'Replay unavailable');
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const created = await runtime.repos.sellerKeys.create({
      orgId: parsed.orgId,
      provider: parsed.provider,
      providerAccountLabel: parsed.providerAccountLabel,
      secret: parsed.secret,
      encryptionKeyId: parsed.encryptionKeyId,
      monthlyCapacityLimitUnits: parsed.monthlyCapacityLimitUnits,
      priorityWeight: parsed.priorityWeight
    });

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      orgId: parsed.orgId,
      action: 'seller_key.create',
      targetType: 'seller_key',
      targetId: created.id,
      metadata: {
        provider: parsed.provider,
        hasMonthlyCapacityLimit: parsed.monthlyCapacityLimitUnits !== undefined,
        priorityWeight: parsed.priorityWeight ?? 100
      }
    });

    const responseBody = { ok: true, id: created.id };
    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 201,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: created.id
    });

    res.status(201).json(responseBody);
  } catch (error) {
    next(error);
  }
});

router.patch('/v1/seller-keys/:id', requireApiKey(runtime.repos.apiKeys, ['admin']), async (req, res, next) => {
  try {
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    const parsed = updateSellerKeySchema.parse(req.body);
    const requestHash = sha256Hex(stableJson({ id: req.params.id, body: parsed }));

    const idemStart = await runtime.services.idempotency.start({
      scope: 'seller_keys_update_v1',
      tenantScope: req.auth?.orgId ?? `admin:${req.auth?.apiKeyId}`,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      if (!idemStart.responseBody) throw new AppError('idempotency_replay_unavailable', 409, 'Replay unavailable');
      res.setHeader('x-idempotent-replay', 'true');
      res.status(idemStart.responseCode).json(idemStart.responseBody);
      return;
    }

    const updated = await runtime.repos.sellerKeys.update(req.params.id, parsed);
    if (!updated) throw new AppError('not_found', 404, 'Seller key not found');

    await logSensitiveAction(runtime.repos.auditLogs, req.auth, {
      action: 'seller_key.update',
      targetType: 'seller_key',
      targetId: req.params.id,
      metadata: {
        status: parsed.status ?? null,
        monthlyCapacityLimitUnits: parsed.monthlyCapacityLimitUnits ?? null,
        priorityWeight: parsed.priorityWeight ?? null
      }
    });

    const responseBody = { ok: true, id: req.params.id };
    await runtime.services.idempotency.commit(idemStart, {
      responseCode: 200,
      responseBody,
      responseDigest: sha256Hex(stableJson(responseBody)),
      responseRef: req.params.id
    });

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
});

export default router;
