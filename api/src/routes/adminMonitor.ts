import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { runtime } from '../services/runtime.js';
import { LiveLaneReadService } from '../services/liveLanes/liveLaneReadService.js';

export const ADMIN_MONITOR_ACTIVITY_PATH = '/v1/admin/monitor/activity';

type AdminMonitorRuntimeDeps = {
  sql: typeof runtime.sql;
  analytics: Pick<typeof runtime.repos.analytics, 'getMonitorArchiveAttempts'>;
  apiKeys: typeof runtime.repos.apiKeys;
};

type AdminMonitorRouterDeps = {
  monitor?: Pick<LiveLaneReadService, 'listAdminMonitorActivityFeed'>;
  runtimeDeps?: AdminMonitorRuntimeDeps;
  serviceFactory?: (
    deps: Pick<AdminMonitorRuntimeDeps, 'sql' | 'analytics'>
  ) => Pick<LiveLaneReadService, 'listAdminMonitorActivityFeed'>;
};

function createDefaultRuntimeDeps(): AdminMonitorRuntimeDeps {
  return {
    sql: runtime.sql,
    analytics: runtime.repos.analytics,
    apiKeys: runtime.repos.apiKeys
  };
}

function createDefaultMonitorService(
  deps: Pick<AdminMonitorRuntimeDeps, 'sql' | 'analytics'>
): Pick<LiveLaneReadService, 'listAdminMonitorActivityFeed'> {
  return new LiveLaneReadService({
    db: deps.sql,
    archiveReader: deps.analytics
  });
}

export function createAdminMonitorRouter(input?: AdminMonitorRouterDeps) {
  const runtimeDeps = input?.runtimeDeps ?? createDefaultRuntimeDeps();
  const monitor = input?.monitor
    ?? input?.serviceFactory?.({
      sql: runtimeDeps.sql,
      analytics: runtimeDeps.analytics
    })
    ?? createDefaultMonitorService(runtimeDeps);
  const router = Router();

  router.get(
    ADMIN_MONITOR_ACTIVITY_PATH,
    requireApiKey(runtimeDeps.apiKeys, ['admin']),
    async (_req, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await monitor.listAdminMonitorActivityFeed());
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

export default createAdminMonitorRouter();
