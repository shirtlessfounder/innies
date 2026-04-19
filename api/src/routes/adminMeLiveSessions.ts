/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
import { MyLiveSessionsService } from '../services/adminLive/myLiveSessionsService.js';
import type { MyLiveSessionsFeed } from '../services/adminLive/myLiveSessionsTypes.js';

export const ADMIN_ME_LIVE_SESSIONS_PATH = '/v1/admin/me/live-sessions';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const querySchema = z.object({
  api_key_ids: z
    .string()
    .trim()
    .min(1, 'api_key_ids must contain at least one UUID'),
  window_hours: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?$/, 'window_hours must be a positive number')
    .optional()
});

function parseApiKeyIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const invalid = ids.find((id) => !UUID_REGEX.test(id));
  if (invalid) {
    throw new InvalidQueryError(`api_key_ids contains invalid uuid: ${invalid}`);
  }

  return Array.from(new Set(ids));
}

class InvalidQueryError extends Error {}

type RouterDeps = {
  liveSessions?: Pick<MyLiveSessionsService, 'listFeed'>;
};

export function buildAdminMeLiveSessionsRouter(deps: RouterDeps = {}): Router {
  const router = Router();
  const liveSessions: Pick<MyLiveSessionsService, 'listFeed'> =
    deps.liveSessions ?? new MyLiveSessionsService({ sql: runtime.sql });

  router.get(
    ADMIN_ME_LIVE_SESSIONS_PATH,
    requireApiKey(runtime.repos.apiKeys, ['admin']),
    async (req, res, next) => {
      try {
        const parseResult = querySchema.safeParse(req.query);
        if (!parseResult.success) {
          res.status(400).json({
            code: 'invalid_query',
            message: parseResult.error.issues[0]?.message ?? 'invalid query'
          });
          return;
        }

        const apiKeyIds = parseApiKeyIds(parseResult.data.api_key_ids);
        const windowHours = parseResult.data.window_hours
          ? Number(parseResult.data.window_hours)
          : undefined;

        const feed: MyLiveSessionsFeed = await liveSessions.listFeed({
          apiKeyIds,
          windowHours
        });

        res.setHeader('Cache-Control', 'no-store');
        res.json(feed);
      } catch (error) {
        if (error instanceof InvalidQueryError) {
          res.status(400).json({ code: 'invalid_query', message: error.message });
          return;
        }
        next(error);
      }
    }
  );

  return router;
}

export default buildAdminMeLiveSessionsRouter();
