/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { RequestHistoryCursor } from '../repos/routingAttributionRepository.js';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30)
});

const requestHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional()
});

const requestHistoryCursorSchema = z.object({
  createdAt: z.string().min(1),
  requestId: z.string().min(1),
  attemptNo: z.number().int().min(1)
});

router.get('/v1/usage/me', requireApiKey(runtime.repos.apiKeys, ['buyer_proxy', 'admin']), async (req, res, next) => {
  try {
    if (!req.auth?.orgId) {
      throw new AppError('forbidden', 403, 'API key is not associated with an org');
    }

    const query = querySchema.parse(req.query);
    const summary = await runtime.repos.usageQuery.getOrgSummary(req.auth.orgId, query.days);
    res.json({
      orgId: req.auth.orgId,
      windowDays: query.days,
      ...summary
    });
  } catch (error) {
    next(error);
  }
});

router.get('/v1/usage/me/requests', requireApiKey(runtime.repos.apiKeys, ['buyer_proxy', 'admin']), async (req, res, next) => {
  try {
    if (!req.auth?.orgId) {
      throw new AppError('forbidden', 403, 'API key is not associated with an org');
    }

    const query = requestHistoryQuerySchema.parse(req.query);
    const cursor = decodeCursor(query.cursor);
    const rows = await runtime.repos.routingAttribution.listOrgRequestHistory({
      orgId: req.auth.orgId,
      limit: query.limit,
      cursor,
      historyScope: 'post_cutover'
    });

    const last = rows[rows.length - 1];
    res.json({
      orgId: req.auth.orgId,
      requests: rows,
      nextCursor: rows.length === query.limit && last ? encodeCursor({
        createdAt: last.created_at,
        requestId: last.request_id,
        attemptNo: last.attempt_no
      }) : null
    });
  } catch (error) {
    next(error);
  }
});

function encodeCursor(cursor: RequestHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): RequestHistoryCursor | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return requestHistoryCursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppError('invalid_request', 400, 'Invalid request-history cursor');
  }
}

export default router;
