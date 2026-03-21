/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
import {
  decodeRequestHistoryCursor,
  encodeRequestHistoryCursor,
  requestHistoryQuerySchema
} from '../utils/requestHistoryCursor.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30)
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
    const cursor = decodeRequestHistoryCursor(query.cursor);
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
      nextCursor: rows.length === query.limit && last ? encodeRequestHistoryCursor({
        createdAt: last.created_at,
        requestId: last.request_id,
        attemptNo: last.attempt_no
      }) : null
    });
  } catch (error) {
    next(error);
  }
});

export default router;
