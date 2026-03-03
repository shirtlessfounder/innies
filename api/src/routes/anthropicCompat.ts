import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { proxyPostHandler } from './proxy.js';
import { runtime } from '../services/runtime.js';

const router = Router();

const anthropicMessagesSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  max_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional()
}).passthrough().superRefine((value, ctx) => {
  if (value.max_tokens == null && value.max_output_tokens == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max_tokens'],
      message: 'Either max_tokens or max_output_tokens is required'
    });
  }
});

function isCompatEndpointEnabled(): boolean {
  return process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED === 'true';
}

router.post(
  '/v1/messages',
  (req, res, next) => {
    if (!isCompatEndpointEnabled()) {
      res.status(404).json({ code: 'not_found', message: 'Not Found' });
      return;
    }
    next();
  },
  requireApiKey(runtime.repos.apiKeys, ['buyer_proxy', 'admin']),
  async (req, res, next) => {
    try {
      const parsed = anthropicMessagesSchema.parse(req.body);

      (req as any).inniesCompatMode = true;
      (req as any).inniesProxiedPath = '/v1/messages';
      req.body = {
        provider: 'anthropic',
        model: parsed.model,
        streaming: parsed.stream === true,
        payload: req.body
      };

      await proxyPostHandler(req as any, res, next as any);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
