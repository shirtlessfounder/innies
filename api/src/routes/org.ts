import { Router } from 'express';
import { runtime } from '../services/runtime.js';
import { createOrgAccessRouter } from './orgAccess.js';
import { createOrgAnalyticsRouter } from './orgAnalytics.js';
import { createOrgAuthRouter } from './orgAuth.js';
import { createOrgManagementRouter } from './orgManagement.js';

type OrgRouteDeps = {
  orgGithubAuth: typeof runtime.services.orgGithubAuth;
  orgSessions: typeof runtime.services.orgSessions;
  orgAccess: typeof runtime.repos.orgAccess;
  orgInvites: typeof runtime.repos.orgInvites;
  orgTokens: typeof runtime.repos.orgTokens;
  orgMemberships: typeof runtime.services.orgMemberships;
  orgTokenManagement: typeof runtime.services.orgTokenManagement;
  analytics: typeof runtime.repos.analytics;
};

export function createOrgRouter(deps: OrgRouteDeps): Router {
  const router = Router();
  router.use(createOrgAuthRouter({
    orgGithubAuth: deps.orgGithubAuth
  }));
  router.use(createOrgAccessRouter({
    orgAccess: deps.orgAccess,
    orgSessions: deps.orgSessions
  }));
  router.use(createOrgManagementRouter({
    orgSessions: deps.orgSessions,
    orgAccess: deps.orgAccess,
    orgInvites: deps.orgInvites,
    orgTokens: deps.orgTokens,
    orgMemberships: deps.orgMemberships,
    orgTokenManagement: deps.orgTokenManagement
  }));
  router.use(createOrgAnalyticsRouter({
    orgSessions: deps.orgSessions,
    orgAccess: deps.orgAccess,
    analytics: deps.analytics as never
  }));
  return router;
}

export default createOrgRouter({
  orgGithubAuth: runtime.services.orgGithubAuth,
  orgSessions: runtime.services.orgSessions,
  orgAccess: runtime.repos.orgAccess,
  orgInvites: runtime.repos.orgInvites,
  orgTokens: runtime.repos.orgTokens,
  orgMemberships: runtime.services.orgMemberships,
  orgTokenManagement: runtime.services.orgTokenManagement,
  analytics: runtime.repos.analytics
});
