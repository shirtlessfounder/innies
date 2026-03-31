import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { runtime } from '../services/runtime.js';
import { AdminArchiveReadService } from '../services/adminArchive/adminArchiveReadService.js';
import { AppError } from '../utils/errors.js';

const analyticsWindowSchema = z.enum(['24h', '7d', '1m', 'all']);
const adminSessionTypeSchema = z.enum(['cli', 'openclaw']);
const adminSessionStatusSchema = z.enum(['success', 'failed', 'partial']);

const sessionCursorPayloadSchema = z.object({
  lastActivityAt: z.string().datetime({ offset: true }),
  sessionKey: z.string().trim().min(1)
});

const sessionCursorSchema = z.string().trim().min(1).transform((value, ctx) => {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    sessionCursorPayloadSchema.parse(JSON.parse(decoded));
    return value;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid archive sessions cursor'
    });
    return z.NEVER;
  }
});

const eventCursorPayloadSchema = z.object({
  eventTime: z.string().datetime({ offset: true }),
  requestId: z.string().trim().min(1),
  attemptNo: z.coerce.number().int().min(1),
  sortOrdinal: z.coerce.number().int()
});

const eventCursorSchema = z.string().trim().min(1).transform((value, ctx) => {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    eventCursorPayloadSchema.parse(JSON.parse(decoded));
    return value;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid archive session events cursor'
    });
    return z.NEVER;
  }
});

const archiveSessionsQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  sessionType: adminSessionTypeSchema.optional(),
  orgId: z.string().uuid().optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  status: adminSessionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: sessionCursorSchema.optional()
}).transform((query) => ({
  window: query.window ?? '7d',
  sessionType: query.sessionType,
  orgId: query.orgId,
  provider: query.provider,
  model: query.model,
  status: query.status,
  limit: query.limit ?? 20,
  cursor: query.cursor
}));

const archiveEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: eventCursorSchema.optional()
}).transform((query) => ({
  limit: query.limit ?? 100,
  cursor: query.cursor
}));

const archiveAttemptParamsSchema = z.object({
  requestId: z.string().trim().min(1),
  attemptNo: z.coerce.number().int().min(1)
});

const defaultAdminArchive = new AdminArchiveReadService({
  sql: runtime.sql,
  adminSessionAttempts: runtime.repos.adminSessionAttempts,
  requestAttemptArchives: runtime.repos.requestAttemptArchives,
  requestAttemptMessages: runtime.repos.requestAttemptMessages,
  requestAttemptRawBlobs: runtime.repos.requestAttemptRawBlobs,
  messageBlobs: runtime.repos.messageBlobs,
  rawBlobs: runtime.repos.rawBlobs
});

export function createAdminArchiveRouter(input?: {
  apiKeys?: Pick<ApiKeyRepository, 'findActiveByHash' | 'touchLastUsed'>;
  adminArchive?: Pick<
    AdminArchiveReadService,
    'listSessions' | 'getSession' | 'listSessionEvents' | 'getAttempt'
  >;
}) {
  const apiKeys = input?.apiKeys ?? runtime.repos.apiKeys;
  const adminArchive = input?.adminArchive ?? defaultAdminArchive;
  const router = Router();

  router.get(
    '/v1/admin/archive/sessions',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const query = archiveSessionsQuerySchema.parse(req.query);
        res.json(await adminArchive.listSessions(query));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/archive/sessions/:sessionKey',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const session = await adminArchive.getSession(String(req.params.sessionKey ?? ''));
        if (!session) {
          throw new AppError('not_found', 404, 'Archive session not found');
        }
        res.json(session);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/archive/sessions/:sessionKey/events',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const query = archiveEventsQuerySchema.parse(req.query);
        const result = await adminArchive.listSessionEvents({
          sessionKey: String(req.params.sessionKey ?? ''),
          limit: query.limit,
          cursor: query.cursor
        });
        if (!result) {
          throw new AppError('not_found', 404, 'Archive session not found');
        }
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/v1/admin/archive/requests/:requestId/attempts/:attemptNo',
    requireApiKey(apiKeys as ApiKeyRepository, ['admin']),
    async (req, res, next) => {
      try {
        const params = archiveAttemptParamsSchema.parse(req.params);
        const result = await adminArchive.getAttempt(params);
        if (!result) {
          throw new AppError('not_found', 404, 'Archived request attempt not found');
        }
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

export default createAdminArchiveRouter();
