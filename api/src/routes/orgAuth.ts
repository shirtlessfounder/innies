/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { readOrgSession } from '../middleware/auth.js';
import {
  buildOrgSessionCookie,
  buildOrgUiRedirectUrl
} from '../services/org/orgSessionCookie.js';
import { runtime } from '../services/runtime.js';

type OrgAuthDeps = {
  orgGithubAuth: {
    buildAuthorizationUrl(input: { returnTo?: string | null }): string;
    finishOauthCallback(input: {
      code: string;
      state: string;
    }): Promise<{ sessionToken: string; returnTo: string | null }>;
  };
  orgSessions: {
    readSession(token: string): {
      actorUserId: string;
      githubLogin: string;
      issuedAt: string;
      expiresAt: string;
    } | null;
  };
  orgAccess: {
    listActiveOrgsForUser(userId: string): Promise<Array<{
      orgId: string;
      orgSlug: string;
      orgName: string;
      membershipId: string;
      isOwner: boolean;
    }>>;
  };
};

const authStartQuerySchema = z.object({
  returnTo: z.string().min(1).optional()
});

const authCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

function normalizeReturnTo(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!normalized.startsWith('/')) return undefined;
  if (normalized.startsWith('//')) return undefined;
  if (normalized.includes('\\')) return undefined;
  return normalized;
}

export function createOrgAuthRouter(deps: OrgAuthDeps): Router {
  const router = Router();

  router.get('/v1/org/session', async (req, res, next) => {
    try {
      const session = readOrgSession(req as never, deps.orgSessions);
      if (!session) {
        res.status(401).json({ code: 'unauthorized', message: 'Missing org session' });
        return;
      }
      const activeOrgs = await deps.orgAccess.listActiveOrgsForUser(session.actorUserId);

      res.status(200).json({
        ok: true,
        session: {
          ...session,
          activeOrgs: activeOrgs.map((org) => ({
            id: org.orgId,
            slug: org.orgSlug,
            name: org.orgName,
            isOwner: org.isOwner
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/org/auth/github/start', async (req, res, next) => {
    try {
      const query = authStartQuerySchema.parse(req.query ?? {});
      const authorizationUrl = deps.orgGithubAuth.buildAuthorizationUrl({
        returnTo: normalizeReturnTo(query.returnTo)
      });
      res.redirect(302, authorizationUrl);
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/org/auth/github/callback', async (req, res, next) => {
    try {
      const query = authCallbackQuerySchema.parse(req.query ?? {});
      const result = await deps.orgGithubAuth.finishOauthCallback({
        code: query.code,
        state: query.state
      });
      res.setHeader('Set-Cookie', buildOrgSessionCookie(result.sessionToken));
      res.redirect(302, buildOrgUiRedirectUrl(normalizeReturnTo(result.returnTo ?? undefined) ?? '/'));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createOrgAuthRouter({
  orgGithubAuth: runtime.services.orgGithubAuth,
  orgSessions: runtime.services.orgSessions,
  orgAccess: runtime.repos.orgAccess
});
