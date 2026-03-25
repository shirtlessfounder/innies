/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { readOrgSession } from '../middleware/auth.js';
import { resolveOrgRouteSlug } from '../services/org/orgRouteSlug.js';
import { runtime } from '../services/runtime.js';

export type OrgAccessResponse =
  | { kind: 'not_found' }
  | {
      kind: 'sign_in_required';
      org: { id: string; slug: string; name: string };
      authStartUrl: string;
    }
  | { kind: 'not_invited'; org: { id: string; slug: string; name: string } }
  | {
      kind: 'pending_invite';
      org: { id: string; slug: string; name: string };
      invite: { inviteId: string; githubLogin: string };
    }
  | {
      kind: 'active_membership';
      org: { id: string; slug: string; name: string };
      membership: { membershipId: string; isOwner: boolean };
    };

type OrgAccessDeps = {
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
  orgSessions: {
    readSession(token: string): {
      actorUserId: string;
      githubLogin: string;
      issuedAt: string;
      expiresAt: string;
    } | null;
  };
};

function buildAuthStartUrl(orgSlug: string): string {
  const params = new URLSearchParams({ returnTo: `/${orgSlug}` });
  return `/v1/org/auth/github/start?${params.toString()}`;
}

export function createOrgAccessRouter(deps: OrgAccessDeps): Router {
  const router = Router();

  router.get('/v1/orgs/:slug/access', async (req, res, next) => {
    try {
      const resolved = await resolveOrgRouteSlug({
        routeSlug: String(req.params.slug ?? ''),
        findOrgBySlug: (slug) => deps.orgAccess.findOrgBySlug(slug)
      });
      if (!resolved) {
        res.status(404).json({ kind: 'not_found' } satisfies OrgAccessResponse);
        return;
      }

      const session = readOrgSession(req, deps.orgSessions);
      if (!session) {
        res.json({
          kind: 'sign_in_required',
          org: {
            id: resolved.org.id,
            slug: resolved.org.slug,
            name: resolved.org.name
          },
          authStartUrl: buildAuthStartUrl(resolved.routeSlug)
        } satisfies OrgAccessResponse);
        return;
      }

      const resolution = await deps.orgAccess.findAuthResolutionBySlugAndGithubLogin({
        orgSlug: resolved.effectiveOrgSlug,
        githubLogin: session.githubLogin
      });

      switch (resolution.kind) {
        case 'active_membership':
          res.json({
            kind: 'active_membership',
            org: {
              id: resolution.orgId,
              slug: resolved.routeSlug,
              name: resolution.orgName
            },
            membership: {
              membershipId: resolution.membershipId,
              isOwner: resolution.isOwner
            }
          } satisfies OrgAccessResponse);
          return;
        case 'pending_invite':
          res.json({
            kind: 'pending_invite',
            org: {
              id: resolution.orgId,
              slug: resolved.routeSlug,
              name: resolution.orgName
            },
            invite: {
              inviteId: resolution.inviteId,
              githubLogin: session.githubLogin
            }
          } satisfies OrgAccessResponse);
          return;
        case 'no_access':
          res.json({
            kind: 'not_invited',
            org: {
              id: resolution.orgId,
              slug: resolved.routeSlug,
              name: resolution.orgName
            }
          } satisfies OrgAccessResponse);
          return;
        case 'org_not_found':
        default:
          res.status(404).json({ kind: 'not_found' } satisfies OrgAccessResponse);
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createOrgAccessRouter({
  orgAccess: runtime.repos.orgAccess,
  orgSessions: runtime.services.orgSessions
});
