/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { readOrgSession } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';

type AnalyticsWindow = '5h' | '24h' | '7d' | '1m' | 'all';
type AnalyticsGranularity = '5m' | '15m' | 'hour' | 'day';

type OrgAnalyticsDeps = {
  orgSessions: {
    readSession(token: string): {
      actorUserId: string;
      githubLogin: string;
      issuedAt: string;
      expiresAt: string;
    } | null;
  };
  orgAccess: {
    findOrgBySlug(slug: string): Promise<{ id: string; slug: string; name: string; ownerUserId: string } | null>;
    findAuthResolutionBySlugAndGithubLogin(input: {
      orgSlug: string;
      githubLogin: string;
    }): Promise<
      | { kind: 'active_membership'; orgId: string; orgSlug: string; orgName: string; userId: string; membershipId: string; isOwner: boolean }
      | { kind: 'pending_invite'; orgId: string; orgSlug: string; orgName: string; inviteId: string }
      | { kind: 'no_access'; orgId: string; orgSlug: string; orgName: string }
      | { kind: 'org_not_found' }
    >;
  };
  analytics: {
    getSystemSummary(filters: {
      window: AnalyticsWindow;
      provider?: string;
      source?: string;
      orgId?: string;
    }): Promise<unknown>;
    getTimeSeries(filters: {
      window: AnalyticsWindow;
      granularity: AnalyticsGranularity;
      provider?: string;
      source?: string;
      credentialId?: string;
      orgId?: string;
    }): Promise<unknown>;
  };
};

const analyticsWindowSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['5h', '24h', '7d', '1m', 'all', '30d']))
  .transform((value) => value === '30d' ? '1m' : value);

const analyticsProviderSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['anthropic', 'openai', 'codex']))
  .transform((provider) => provider === 'codex' ? 'openai' : provider);

const analyticsSourceSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['openclaw', 'cli-claude', 'cli-codex', 'direct']));

const analyticsGranularitySchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['5m', '15m', 'hour', 'day']));

const dashboardQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  provider: analyticsProviderSchema.optional(),
  source: analyticsSourceSchema.optional()
}).transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

const timeSeriesQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  provider: analyticsProviderSchema.optional(),
  source: analyticsSourceSchema.optional(),
  granularity: analyticsGranularitySchema.optional(),
  credentialId: z.string().uuid().optional()
}).transform((query) => {
  const window = query.window ?? '24h';
  return {
    window,
    provider: query.provider,
    source: query.source,
    credentialId: query.credentialId,
    granularity: query.granularity ?? (window === '5h' ? '5m' : window === '24h' ? '15m' : window === '7d' ? 'hour' : 'day')
  };
});

async function requireOrgAnalyticsContext(
  req: Parameters<Router['get']>[1],
  deps: Pick<OrgAnalyticsDeps, 'orgAccess' | 'orgSessions'>
) {
  const orgSlug = String((req as any).params.slug ?? '').trim().toLowerCase();
  const org = await deps.orgAccess.findOrgBySlug(orgSlug);
  if (!org) {
    throw new AppError('not_found', 404, `Org not found: ${orgSlug}`);
  }

  const session = readOrgSession(req as never, deps.orgSessions);
  if (!session) {
    throw new AppError('unauthorized', 401, 'Missing org session');
  }

  const resolution = await deps.orgAccess.findAuthResolutionBySlugAndGithubLogin({
    orgSlug,
    githubLogin: session.githubLogin
  });

  if (resolution.kind !== 'active_membership') {
    throw new AppError('forbidden', 403, 'Active org membership is required');
  }

  return {
    orgId: resolution.orgId,
    orgSlug: resolution.orgSlug
  };
}

export function createOrgAnalyticsRouter(deps: OrgAnalyticsDeps): Router {
  const router = Router();

  router.get('/v1/orgs/:slug/analytics/dashboard', async (req, res, next) => {
    try {
      const context = await requireOrgAnalyticsContext(req as never, deps);
      const query = dashboardQuerySchema.parse(req.query ?? {});
      const summary = await deps.analytics.getSystemSummary({
        ...query,
        orgId: context.orgId
      });
      res.json({
        window: query.window,
        ...summary as Record<string, unknown>
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/orgs/:slug/analytics/timeseries', async (req, res, next) => {
    try {
      const context = await requireOrgAnalyticsContext(req as never, deps);
      const query = timeSeriesQuerySchema.parse(req.query ?? {});
      const series = await deps.analytics.getTimeSeries({
        ...query,
        orgId: context.orgId
      });
      res.json({
        window: query.window,
        granularity: query.granularity,
        series
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createOrgAnalyticsRouter({
  orgSessions: runtime.services.orgSessions,
  orgAccess: runtime.repos.orgAccess,
  analytics: runtime.repos.analytics as never
});
