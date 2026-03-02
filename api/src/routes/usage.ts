import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
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

export default router;
