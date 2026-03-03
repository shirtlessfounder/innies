import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { proxyPostHandler } from './proxy.js';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const anthropicMessagesSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  max_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional()
}).passthrough().superRefine((value, ctx) => {
  const maxMessageCountRaw = Number(process.env.ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT || 1000);
  const maxMessageCount = Number.isFinite(maxMessageCountRaw) && maxMessageCountRaw > 0
    ? Math.floor(maxMessageCountRaw)
    : 1000;

  if (value.max_tokens == null && value.max_output_tokens == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max_tokens'],
      message: 'Either max_tokens or max_output_tokens is required'
    });
  }

  if (value.messages.length > maxMessageCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: `messages exceeds max allowed count (${maxMessageCount})`
    });
  }
});

function isCompatEndpointEnabled(): boolean {
  return process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED === 'true';
}

function normalizeThinkingForCompat(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  const thinkingRaw = normalized.thinking;
  if (!thinkingRaw || typeof thinkingRaw !== 'object') {
    return normalized;
  }

  const thinking = { ...(thinkingRaw as Record<string, unknown>) };
  if (thinking.type !== 'enabled') {
    normalized.thinking = thinking;
    return normalized;
  }

  let budgetTokens: number;
  if (thinking.budget_tokens == null) {
    budgetTokens = 1024;
    thinking.budget_tokens = budgetTokens;
  } else if (typeof thinking.budget_tokens === 'number' && Number.isInteger(thinking.budget_tokens) && thinking.budget_tokens > 0) {
    budgetTokens = thinking.budget_tokens;
  } else {
    throw new AppError(
      'invalid_request',
      400,
      'thinking.enabled requires thinking.budget_tokens to be a positive integer',
      { budgetTokens: thinking.budget_tokens }
    );
  }

  if (budgetTokens < 1024) {
    budgetTokens = 1024;
    thinking.budget_tokens = budgetTokens;
  }

  const maxTokensRaw = normalized.max_tokens ?? normalized.max_output_tokens;
  const maxTokens = typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw)
    ? maxTokensRaw
    : null;

  if (maxTokens !== null && maxTokens <= budgetTokens) {
    throw new AppError(
      'invalid_request',
      400,
      'thinking.enabled requires max_tokens (or max_output_tokens) greater than thinking.budget_tokens',
      { maxTokens, budgetTokens }
    );
  }

  normalized.thinking = thinking;
  return normalized;
}

function normalizeToolChoiceForCompat(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  const toolChoice = normalized.tool_choice;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'any') {
    normalized.tool_choice = { type: toolChoice };
  }
  return normalized;
}

function getMaxCompatRequestBytes(): number {
  const maxRequestBytesRaw = Number(process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES || 5_000_000);
  return Number.isFinite(maxRequestBytesRaw) && maxRequestBytesRaw > 0
    ? Math.floor(maxRequestBytesRaw)
    : 5_000_000;
}

function enforceCompatRequestBytesGuardrail(req: { header: (name: string) => string | undefined; body: unknown }): void {
  const maxRequestBytes = getMaxCompatRequestBytes();
  const declaredLengthRaw = req.header('content-length');
  const declaredLength = declaredLengthRaw ? Number(declaredLengthRaw) : NaN;

  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
    throw new AppError(
      'invalid_request',
      400,
      `request payload exceeds max allowed bytes (${maxRequestBytes})`,
      { maxRequestBytes, contentLength: declaredLength }
    );
  }

  if (!Number.isFinite(declaredLength)) {
    const payloadBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (payloadBytes > maxRequestBytes) {
      throw new AppError(
        'invalid_request',
        400,
        `request payload exceeds max allowed bytes (${maxRequestBytes})`,
        { maxRequestBytes, payloadBytes }
      );
    }
  }
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
      enforceCompatRequestBytesGuardrail(req as any);
      const parsed = anthropicMessagesSchema.parse(req.body);
      const withThinking = normalizeThinkingForCompat(parsed as Record<string, unknown>);
      const normalizedPayload = normalizeToolChoiceForCompat(withThinking);

      (req as any).inniesCompatMode = true;
      (req as any).inniesProxiedPath = '/v1/messages';
      req.body = {
        provider: 'anthropic',
        model: parsed.model,
        streaming: parsed.stream === true,
        payload: normalizedPayload
      };

      await proxyPostHandler(req as any, res, next as any);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
