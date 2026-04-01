import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { runtime } from '../services/runtime.js';
import { AdminAnalysisReadService } from '../services/adminAnalysis/adminAnalysisReadService.js';
import { AppError } from '../utils/errors.js';

const adminAnalysisWindowSchema = z.enum(['24h', '7d', '1m', 'all']);
const adminAnalysisCompareSchema = z.enum(['prev']);
const adminAnalysisSessionTypeSchema = z.enum(['cli', 'openclaw']);
const adminAnalysisTaskCategorySchema = z.enum([
  'debugging',
  'feature_building',
  'code_review',
  'research',
  'ops',
  'writing',
  'data_analysis',
  'other'
]);
const adminAnalysisSourceSchema = z.enum(['openclaw', 'cli-claude', 'cli-codex', 'direct']);

const providerSchema = z.string().trim().min(1).max(200);
const taskTagSchema = z.string().trim().min(1).max(100);

function rejectDirectSource(
  query: { source?: string | undefined },
  ctx: z.RefinementCtx
) {
  if (query.source === 'direct') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source'],
      message: 'source=direct is not supported for admin analysis'
    });
  }
}

const baseAnalysisQuerySchema = z.object({
  window: adminAnalysisWindowSchema.optional(),
  compare: adminAnalysisCompareSchema.optional(),
  orgId: z.string().uuid().optional(),
  sessionType: adminAnalysisSessionTypeSchema.optional(),
  provider: providerSchema.optional(),
  source: adminAnalysisSourceSchema.optional(),
  taskCategory: adminAnalysisTaskCategorySchema.optional(),
  taskTag: taskTagSchema.optional()
}).superRefine(rejectDirectSource);

const overviewQuerySchema = baseAnalysisQuerySchema.transform((query) => ({
  window: query.window ?? '7d',
  compare: query.compare,
  orgId: query.orgId,
  sessionType: query.sessionType,
  provider: query.provider,
  source: query.source,
  taskCategory: query.taskCategory,
  taskTag: query.taskTag
}));

const categoriesQuerySchema = z.object({
  window: adminAnalysisWindowSchema.optional(),
  compare: adminAnalysisCompareSchema.optional(),
  orgId: z.string().uuid().optional(),
  sessionType: adminAnalysisSessionTypeSchema.optional(),
  provider: providerSchema.optional(),
  source: adminAnalysisSourceSchema.optional()
}).superRefine(rejectDirectSource).transform((query) => ({
  window: query.window ?? '7d',
  compare: query.compare,
  orgId: query.orgId,
  sessionType: query.sessionType,
  provider: query.provider,
  source: query.source
}));

const tagsQuerySchema = z.object({
  window: adminAnalysisWindowSchema.optional(),
  compare: adminAnalysisCompareSchema.optional(),
  orgId: z.string().uuid().optional(),
  sessionType: adminAnalysisSessionTypeSchema.optional(),
  provider: providerSchema.optional(),
  source: adminAnalysisSourceSchema.optional(),
  taskCategory: adminAnalysisTaskCategorySchema.optional()
}).superRefine(rejectDirectSource).transform((query) => ({
  window: query.window ?? '7d',
  compare: query.compare,
  orgId: query.orgId,
  sessionType: query.sessionType,
  provider: query.provider,
  source: query.source,
  taskCategory: query.taskCategory
}));

const interestingSignalsQuerySchema = baseAnalysisQuerySchema.transform((query) => ({
  window: query.window ?? '7d',
  compare: query.compare,
  orgId: query.orgId,
  sessionType: query.sessionType,
  provider: query.provider,
  source: query.source,
  taskCategory: query.taskCategory,
  taskTag: query.taskTag
}));

const requestSamplesQuerySchema = z.object({
  window: adminAnalysisWindowSchema.optional(),
  orgId: z.string().uuid().optional(),
  sessionType: adminAnalysisSessionTypeSchema.optional(),
  provider: providerSchema.optional(),
  source: adminAnalysisSourceSchema.optional(),
  taskCategory: adminAnalysisTaskCategorySchema.optional(),
  taskTag: taskTagSchema.optional(),
  sampleSize: z.coerce.number().int().min(1).max(200).optional()
}).superRefine(rejectDirectSource).transform((query) => ({
  window: query.window ?? '24h',
  orgId: query.orgId,
  sessionType: query.sessionType,
  provider: query.provider,
  source: query.source,
  taskCategory: query.taskCategory,
  taskTag: query.taskTag,
  sampleSize: query.sampleSize ?? 10
}));

const sessionSamplesQuerySchema = requestSamplesQuerySchema;

const requestDetailParamsSchema = z.object({
  requestId: z.string().trim().min(1),
  attemptNo: z.coerce.number().int().min(1)
});

const sessionDetailParamsSchema = z.object({
  sessionKey: z.string().trim().min(1)
});

const defaultAdminAnalysis = runtime.services.adminAnalysisRead;

export function createAdminAnalysisRouter(input?: {
  apiKeys?: Pick<ApiKeyRepository, 'findActiveByHash' | 'touchLastUsed'>;
  adminAnalysis?: Pick<
    AdminAnalysisReadService,
    | 'getOverview'
    | 'getCategoryTrends'
    | 'getTagTrends'
    | 'getInterestingSignals'
    | 'getRequestSamples'
    | 'getSessionSamples'
    | 'getRequestDetail'
    | 'getSessionDetail'
  >;
}) {
  const apiKeys = input?.apiKeys ?? runtime.repos.apiKeys;
  const adminAnalysis = input?.adminAnalysis ?? defaultAdminAnalysis;
  const router = Router();

  router.get(
    '/v1/admin/analysis/overview',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        res.json(await adminAnalysis.getOverview(overviewQuerySchema.parse(req.query)));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/categories',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        res.json(await adminAnalysis.getCategoryTrends(categoriesQuerySchema.parse(req.query)));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/tags',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        res.json(await adminAnalysis.getTagTrends(tagsQuerySchema.parse(req.query)));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/interesting-signals',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        res.json(await adminAnalysis.getInterestingSignals(interestingSignalsQuerySchema.parse(req.query)));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/samples/requests',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const response = await adminAnalysis.getRequestSamples(requestSamplesQuerySchema.parse(req.query));
        res.json({
          ...response,
          samples: Array.isArray(response.samples) ? response.samples.map((sample) => normalizeRequestRow(sample)) : []
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/samples/sessions',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const response = await adminAnalysis.getSessionSamples(sessionSamplesQuerySchema.parse(req.query));
        res.json({
          ...response,
          samples: Array.isArray(response.samples) ? response.samples.map((sample) => normalizeSessionRow(sample)) : []
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/requests/:requestId/attempts/:attemptNo',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const params = requestDetailParamsSchema.parse(req.params);
        const result = await adminAnalysis.getRequestDetail(params.requestId, params.attemptNo);
        if (!result) {
          throw new AppError('not_found', 404, 'Analysis request attempt not found');
        }
        res.json(normalizeRequestRow(result.row));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/analysis/sessions/:sessionKey',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const params = sessionDetailParamsSchema.parse(req.params);
        const result = await adminAnalysis.getSessionDetail(params.sessionKey);
        if (!result) {
          throw new AppError('not_found', 404, 'Analysis session not found');
        }
        res.json(normalizeSessionRow(result.row));
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

function normalizeRequestRow(row: Record<string, unknown>) {
  const requestId = String(row.request_id ?? '');
  const attemptNo = Number(row.attempt_no ?? 0);
  const sessionKey = String(row.session_key ?? '');

  return {
    requestAttemptArchiveId: String(row.request_attempt_archive_id ?? ''),
    requestId,
    attemptNo,
    sessionKey,
    orgId: String(row.org_id ?? ''),
    apiKeyId: row.api_key_id == null ? null : String(row.api_key_id),
    sessionType: row.session_type,
    groupingBasis: row.grouping_basis,
    source: row.source,
    provider: row.provider,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    userMessagePreview: row.user_message_preview ?? null,
    assistantTextPreview: row.assistant_text_preview ?? null,
    taskCategory: row.task_category,
    taskTags: Array.isArray(row.task_tags) ? row.task_tags : [],
    interestingnessScore: Number(row.interestingness_score ?? 0),
    signals: {
      isRetry: Boolean(row.is_retry),
      isFailure: Boolean(row.is_failure),
      isPartial: Boolean(row.is_partial),
      isHighToken: Boolean(row.is_high_token),
      isCrossProviderRescue: Boolean(row.is_cross_provider_rescue),
      hasToolUse: Boolean(row.has_tool_use)
    },
    archiveRefs: {
      requestAttempt: `/v1/admin/archive/requests/${encodeURIComponent(requestId)}/attempts/${attemptNo}`,
      session: `/v1/admin/archive/sessions/${encodeURIComponent(sessionKey)}`
    }
  };
}

function normalizeSessionRow(row: Record<string, unknown>) {
  const sessionKey = String(row.session_key ?? '');

  return {
    sessionKey,
    orgId: String(row.org_id ?? ''),
    sessionType: row.session_type,
    groupingBasis: row.grouping_basis,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastActivityAt: row.last_activity_at,
    requestCount: Number(row.request_count ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    primaryTaskCategory: row.primary_task_category,
    taskCategoryBreakdown: row.task_category_breakdown ?? {},
    taskTagSet: Array.isArray(row.task_tag_set) ? row.task_tag_set : [],
    interestingnessScore: Number(row.interestingness_score ?? 0),
    signals: {
      isLongSession: Boolean(row.is_long_session),
      isHighTokenSession: Boolean(row.is_high_token_session),
      isRetryHeavySession: Boolean(row.is_retry_heavy_session),
      isCrossProviderSession: Boolean(row.is_cross_provider_session),
      isMultiModelSession: Boolean(row.is_multi_model_session)
    },
    archiveRefs: {
      session: `/v1/admin/archive/sessions/${encodeURIComponent(sessionKey)}`,
      sessionEvents: `/v1/admin/archive/sessions/${encodeURIComponent(sessionKey)}/events`
    }
  };
}

export default createAdminAnalysisRouter();
