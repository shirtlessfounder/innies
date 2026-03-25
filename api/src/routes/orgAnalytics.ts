/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { readOrgSession } from '../middleware/auth.js';
import { resolveOrgRouteSlug } from '../services/org/orgRouteSlug.js';
import { buildDashboardSnapshotPayload } from '../services/analytics/dashboardSnapshot.js';
import { runtime } from '../services/runtime.js';
import type {
  AnalyticsGranularity,
  AnalyticsRouteRepository
} from './analytics.js';
import {
  dashboardSnapshotShape,
  defaultGranularity,
  normalizeBuyerTimeSeries,
  normalizeTimeSeries
} from './analytics.js';
import type { AnalyticsWindow } from '../utils/analytics.js';
import { AppError } from '../utils/errors.js';

type AnalyticsPageWindow = '5h' | '24h' | '1w' | '1m';
type AnalyticsMetric = 'usageUnits' | 'requests' | 'latencyP50Ms' | 'errorRate';

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
  analytics: AnalyticsRouteRepository;
};

const analyticsWindowSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['5h', '24h', '1w', '7d', '1m', 'all', '30d']))
  .transform((value): { window: AnalyticsPageWindow; effectiveWindow: AnalyticsWindow } => {
    if (value === '1w' || value === '7d') {
      return { window: '1w', effectiveWindow: '7d' };
    }
    if (value === '30d') {
      return { window: '1m', effectiveWindow: '1m' };
    }
    if (value === 'all') {
      return { window: '1m', effectiveWindow: 'all' };
    }
    return { window: value, effectiveWindow: value };
  });

const analyticsProviderSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['anthropic', 'openai', 'codex']))
  .transform((provider) => provider === 'codex' ? 'openai' : provider);

const analyticsSourceSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['openclaw', 'cli-claude', 'cli-codex', 'direct']));

const dashboardQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  provider: analyticsProviderSchema.optional(),
  source: analyticsSourceSchema.optional()
}).transform((query) => ({
  window: query.window?.window ?? '24h',
  effectiveWindow: query.window?.effectiveWindow ?? '24h',
  provider: query.provider,
  source: query.source
}));

const timeSeriesQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  entityType: z.enum(['token', 'buyer']),
  entityId: z.string().uuid(),
  metric: z.enum(['usageUnits', 'requests', 'latencyP50Ms', 'errorRate']).default('usageUnits')
}).transform((query) => {
  const window = query.window?.window ?? '24h';
  const effectiveWindow = query.window?.effectiveWindow ?? '24h';
  return {
    window,
    effectiveWindow,
    entityType: query.entityType,
    entityId: query.entityId,
    metric: query.metric,
    granularity: defaultGranularity(effectiveWindow)
  };
});

function buildDashboardCapabilities() {
  return {
    supports5hWindow: true,
    buyersComplete: true,
    buyerSeriesAvailable: true,
    lifecycleEventsAvailable: true,
    dashboardSnapshotAvailable: true,
    timeseriesMultiEntityAvailable: false
  };
}

function metricValue(metric: AnalyticsMetric, point: Record<string, unknown>): number {
  if (metric === 'requests') {
    return typeof point.requests === 'number' ? point.requests : 0;
  }
  if (metric === 'latencyP50Ms') {
    return typeof point.latencyP50Ms === 'number' ? point.latencyP50Ms : 0;
  }
  if (metric === 'errorRate') {
    return typeof point.errorRate === 'number' ? point.errorRate : 0;
  }
  return typeof point.usageUnits === 'number' ? point.usageUnits : 0;
}

function normalizeSeriesPoints(metric: AnalyticsMetric, rows: Array<Record<string, unknown>>) {
  return rows
    .map((row) => {
      const timestamp = typeof row.date === 'string' ? row.date : null;
      if (!timestamp) return null;
      return {
        timestamp,
        value: metricValue(metric, row)
      };
    })
    .filter((row): row is { timestamp: string; value: number } => row !== null);
}

async function requireOrgAnalyticsContext(
  req: Parameters<Router['get']>[1],
  deps: Pick<OrgAnalyticsDeps, 'orgAccess' | 'orgSessions'>
) {
  const resolved = await resolveOrgRouteSlug({
    routeSlug: String((req as any).params.slug ?? ''),
    findOrgBySlug: (slug) => deps.orgAccess.findOrgBySlug(slug)
  });
  if (!resolved) {
    const routeSlug = String((req as any).params.slug ?? '').trim().toLowerCase();
    throw new AppError('not_found', 404, `Org not found: ${routeSlug}`);
  }

  const session = readOrgSession(req as never, deps.orgSessions);
  if (!session) {
    throw new AppError('unauthorized', 401, 'Missing org session');
  }

  const resolution = await deps.orgAccess.findAuthResolutionBySlugAndGithubLogin({
    orgSlug: resolved.effectiveOrgSlug,
    githubLogin: session.githubLogin
  });

  if (resolution.kind !== 'active_membership') {
    throw new AppError('forbidden', 403, 'Active org membership is required');
  }

  return {
    orgId: resolution.orgId
  };
}

export function createOrgAnalyticsRouter(deps: OrgAnalyticsDeps): Router {
  const router = Router();

  router.get('/v1/orgs/:slug/analytics/dashboard', async (req, res, next) => {
    try {
      const context = await requireOrgAnalyticsContext(req as never, deps);
      const query = dashboardQuerySchema.parse(req.query ?? {});
      const snapshot = await buildDashboardSnapshotPayload({
        analytics: deps.analytics,
        query: {
          window: query.effectiveWindow,
          provider: query.provider,
          source: query.source,
          orgId: context.orgId
        },
        shape: dashboardSnapshotShape
      });
      res.json({
        ...snapshot,
        window: query.window,
        effectiveWindow: query.effectiveWindow,
        capabilities: buildDashboardCapabilities()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/orgs/:slug/analytics/timeseries', async (req, res, next) => {
    try {
      const context = await requireOrgAnalyticsContext(req as never, deps);
      const query = timeSeriesQuerySchema.parse(req.query ?? {});
      if (query.entityType === 'buyer') {
        const series = await deps.analytics.getBuyerTimeSeries({
          window: query.effectiveWindow,
          granularity: query.granularity,
          apiKeyIds: [query.entityId],
          orgId: context.orgId
        });
        const normalizedSeries = normalizeSeriesPoints(query.metric, normalizeBuyerTimeSeries(series));
        res.json({
          window: query.window,
          effectiveWindow: query.effectiveWindow,
          entityType: query.entityType,
          entityId: query.entityId,
          metric: query.metric,
          partial: false,
          warning: null,
          series: normalizedSeries
        });
        return;
      }

      const series = await deps.analytics.getTimeSeries({
        window: query.effectiveWindow,
        granularity: query.granularity,
        credentialId: query.entityId,
        orgId: context.orgId
      });
      const normalizedSeries = normalizeSeriesPoints(query.metric, normalizeTimeSeries(series));
      res.json({
        window: query.window,
        effectiveWindow: query.effectiveWindow,
        entityType: query.entityType,
        entityId: query.entityId,
        metric: query.metric,
        partial: false,
        warning: null,
        series: normalizedSeries
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
