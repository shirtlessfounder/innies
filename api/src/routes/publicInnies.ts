import { Router } from 'express';
import type express from 'express';
import { runtime } from '../services/runtime.js';
import { PublicLiveSessionsService } from '../services/publicInnies/publicLiveSessionsService.js';

const PUBLIC_LIVE_SESSIONS_PATH = '/v1/public/innies/live-sessions';
const FALLBACK_PUBLIC_WEB_ORIGINS = [
  'https://innies.work',
  'https://www.innies.work',
  'http://localhost:3000'
];
const PUBLIC_FEED_CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=25';

type PublicLiveSessionsRouteRuntimeDeps = {
  sql: typeof runtime.sql;
  orgAccess: typeof runtime.repos.orgAccess;
  apiKeys: typeof runtime.repos.apiKeys;
};

type PublicInniesRouterDeps = {
  liveSessions?: Pick<PublicLiveSessionsService, 'listFeed'>;
  env?: NodeJS.ProcessEnv;
  runtimeDeps?: PublicLiveSessionsRouteRuntimeDeps;
  serviceFactory?: (deps: PublicLiveSessionsRouteRuntimeDeps) => Pick<PublicLiveSessionsService, 'listFeed'>;
};

function createDefaultRuntimeDeps(): PublicLiveSessionsRouteRuntimeDeps {
  return {
    sql: runtime.sql,
    orgAccess: runtime.repos.orgAccess,
    apiKeys: runtime.repos.apiKeys
  };
}

function createDefaultPublicLiveSessionsService(
  deps: PublicLiveSessionsRouteRuntimeDeps
): Pick<PublicLiveSessionsService, 'listFeed'> {
  return new PublicLiveSessionsService(deps);
}

function readAllowedOrigins(env: NodeJS.ProcessEnv | undefined): Set<string> {
  const configuredOrigins = (env?.INNIES_PUBLIC_WEB_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set(configuredOrigins.length > 0 ? configuredOrigins : FALLBACK_PUBLIC_WEB_ORIGINS);
}

function appendVary(res: express.Response, value: string): void {
  const existing = String(res.getHeader('Vary') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!existing.includes(value)) {
    existing.push(value);
  }

  res.setHeader('Vary', existing.join(', '));
}

function applyRouteCors(
  req: express.Request,
  res: express.Response,
  env: NodeJS.ProcessEnv | undefined
): void {
  const origin = req.header('origin');
  const allowedOrigins = readAllowedOrigins(env);

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  appendVary(res, 'Origin');
}

function applyPublicFeedCacheHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', PUBLIC_FEED_CACHE_CONTROL);
}

export function createPublicInniesRouter(input?: PublicInniesRouterDeps) {
  const env = input?.env ?? process.env;
  const runtimeDeps = input?.runtimeDeps ?? createDefaultRuntimeDeps();
  const liveSessions = input?.liveSessions
    ?? input?.serviceFactory?.(runtimeDeps)
    ?? createDefaultPublicLiveSessionsService(runtimeDeps);
  const router = Router();

  router.options(PUBLIC_LIVE_SESSIONS_PATH, (req, res) => {
    applyRouteCors(req, res, env);
    res.status(204).send();
  });

  router.get(PUBLIC_LIVE_SESSIONS_PATH, async (req, res, next) => {
    try {
      applyRouteCors(req, res, env);
      applyPublicFeedCacheHeaders(res);
      res.json(await liveSessions.listFeed());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createPublicInniesRouter();
