/// <reference path="../types/express.d.ts" />

import { Router } from 'express';
import { z } from 'zod';
import { readOrgSession, requireOrgSession } from '../middleware/auth.js';
import { resolveOrgRouteSlug } from '../services/org/orgRouteSlug.js';
import { runtime } from '../services/runtime.js';
import { buildOrgRevealCookie } from '../services/org/orgSessionCookie.js';
import { AppError } from '../utils/errors.js';

type OrgManagementDeps = {
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
    listMembers(orgId: string): Promise<Array<{
      userId: string;
      githubLogin: string | null;
      membershipId: string;
      isOwner: boolean;
    }>>;
  };
  orgInvites: {
    listPendingByOrg(orgId: string): Promise<Array<{
      inviteId: string;
      githubLogin: string;
      createdAt: string;
      createdByUserId: string;
    }>>;
  };
  orgTokens: {
    listOrgTokens(orgId: string): Promise<Array<{
      tokenId: string;
      provider: string;
      status: string;
      createdByUserId: string | null;
      createdByGithubLogin: string | null;
      debugLabel: string | null;
      fiveHourReservePercent: number;
      sevenDayReservePercent: number;
    }>>;
  };
  orgMemberships: {
    createOrg(input: {
      orgName: string;
      actorUserId: string;
      actorGithubLogin: string;
    }): Promise<{ orgId: string; orgSlug: string; reveal: { buyerKey: string; reason: 'org_created' } }>;
    createInvite(input: {
      orgSlug: string;
      actorUserId: string;
      githubLogin: string;
    }): Promise<
      | { kind: 'invite_created'; inviteId: string; createdFresh: boolean }
      | { kind: 'already_a_member' }
    >;
    revokeInvite(input: {
      orgSlug: string;
      actorUserId: string;
      inviteId: string;
    }): Promise<void>;
    acceptInvite(input: {
      orgSlug: string;
      actorUserId: string;
      actorGithubLogin: string;
    }): Promise<
      | { kind: 'invite_accepted'; membershipId: string; reveal: { buyerKey: string; reason: 'invite_accepted' } }
      | { kind: 'already_active_member'; membershipId: string }
      | { kind: 'invite_no_longer_valid' }
    >;
    leaveOrg(input: {
      orgSlug: string;
      actorUserId: string;
    }): Promise<{ membershipId: string }>;
    removeMember(input: {
      orgSlug: string;
      actorUserId: string;
      memberUserId: string;
    }): Promise<{ membershipId: string }>;
  };
  orgTokenManagement: {
    addOrgToken(input: {
      orgSlug: string;
      actorUserId: string;
      provider: string;
      debugLabel?: string;
      token: string;
      refreshToken: string;
      fiveHourReservePercent?: number;
      sevenDayReservePercent?: number;
    }): Promise<{ tokenId: string }>;
    updateOrgTokenReserve(input: {
      orgSlug: string;
      actorUserId: string;
      tokenId: string;
      fiveHourReservePercent: number;
      sevenDayReservePercent: number;
    }): Promise<{
      tokenId: string;
      fiveHourReservePercent: number;
      sevenDayReservePercent: number;
    }>;
    probeOrgToken(input: {
      orgSlug: string;
      actorUserId: string;
      tokenId: string;
    }): Promise<{
      tokenId: string;
      probeOk: boolean;
      reactivated: boolean;
      status: 'active' | 'maxed';
      reason: string;
      nextProbeAt: string | null;
    }>;
    refreshOrgToken(input: {
      orgSlug: string;
      actorUserId: string;
      tokenId: string;
    }): Promise<void>;
    removeOrgToken(input: {
      orgSlug: string;
      actorUserId: string;
      tokenId: string;
    }): Promise<void>;
  };
};

const createOrgSchema = z.object({
  orgName: z.string().trim().min(1).max(120)
});

const createInviteSchema = z.object({
  githubLogin: z.string().trim().min(1)
});

const revokeInviteSchema = z.object({
  inviteId: z.string().trim().min(1)
});

const reservePercentSchema = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return value;
}, z.number().int().min(0).max(100).optional());

const addTokenSchema = z.object({
  provider: z.string().trim().min(1),
  debugLabel: z.string().trim().min(1).max(64).optional(),
  token: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  fiveHourReservePercent: reservePercentSchema.optional(),
  sevenDayReservePercent: reservePercentSchema.optional()
});

const updateTokenReserveSchema = z.object({
  fiveHourReservePercent: reservePercentSchema,
  sevenDayReservePercent: reservePercentSchema
}).superRefine((value, ctx) => {
  if (value.fiveHourReservePercent === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'fiveHourReservePercent is required',
      path: ['fiveHourReservePercent']
    });
  }
  if (value.sevenDayReservePercent === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sevenDayReservePercent is required',
      path: ['sevenDayReservePercent']
    });
  }
});

async function resolveActiveMembershipContext(
  req: Parameters<Router['get']>[1],
  deps: Pick<OrgManagementDeps, 'orgAccess' | 'orgSessions'>
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
    org: resolved.org,
    effectiveOrgSlug: resolved.effectiveOrgSlug,
    routeOrgSlug: resolved.routeSlug,
    session,
    membership: {
      membershipId: resolution.membershipId,
      isOwner: resolution.isOwner
    }
  };
}

function assertOwner(isOwner: boolean): void {
  if (!isOwner) {
    throw new AppError('forbidden', 403, 'Owner access required');
  }
}

export function createOrgManagementRouter(deps: OrgManagementDeps): Router {
  const router = Router();

  router.post('/v1/orgs', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const body = createOrgSchema.parse(req.body ?? {});
      const session = req.orgSession;
      if (!session) {
        throw new AppError('unauthorized', 401, 'Missing org session');
      }

      const created = await deps.orgMemberships.createOrg({
        orgName: body.orgName,
        actorUserId: session.actorUserId,
        actorGithubLogin: session.githubLogin
      });

      res.setHeader('Set-Cookie', buildOrgRevealCookie({
        orgSlug: created.orgSlug,
        buyerKey: created.reveal.buyerKey,
        reason: created.reveal.reason
      }));
      res.status(201).json({ orgSlug: created.orgSlug });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/invites', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      assertOwner(context.membership.isOwner);
      const body = createInviteSchema.parse(req.body ?? {});
      const created = await deps.orgMemberships.createInvite({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        githubLogin: body.githubLogin
      });

      if (created.kind === 'already_a_member') {
        res.json(created);
        return;
      }

      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/invites/accept', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const session = req.orgSession;
      if (!session) {
        throw new AppError('unauthorized', 401, 'Missing org session');
      }
      const resolved = await resolveOrgRouteSlug({
        routeSlug: String(req.params.slug ?? ''),
        findOrgBySlug: (slug) => deps.orgAccess.findOrgBySlug(slug)
      });
      if (!resolved) {
        const routeSlug = String(req.params.slug ?? '').trim().toLowerCase();
        throw new AppError('not_found', 404, `Org not found: ${routeSlug}`);
      }

      const accepted = await deps.orgMemberships.acceptInvite({
        orgSlug: resolved.effectiveOrgSlug,
        actorUserId: session.actorUserId,
        actorGithubLogin: session.githubLogin
      });

      if (accepted.kind === 'invite_accepted') {
        res.setHeader('Set-Cookie', buildOrgRevealCookie({
          orgSlug: resolved.routeSlug,
          buyerKey: accepted.reveal.buyerKey,
          reason: accepted.reveal.reason
        }));
        res.json({ orgSlug: resolved.routeSlug });
        return;
      }

      if (accepted.kind === 'already_active_member') {
        res.json({ orgSlug: resolved.routeSlug });
        return;
      }

      throw new AppError('invite_no_longer_valid', 409, 'Invite is no longer valid');
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/invites/revoke', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      assertOwner(context.membership.isOwner);
      const body = revokeInviteSchema.parse(req.body ?? {});
      await deps.orgMemberships.revokeInvite({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        inviteId: body.inviteId
      });
      res.json({
        inviteId: body.inviteId,
        status: 'revoked'
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/orgs/:slug/members', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      const members = await deps.orgAccess.listMembers(context.org.id);
      res.json({ members });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/orgs/:slug/invites', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      assertOwner(context.membership.isOwner);
      const invites = await deps.orgInvites.listPendingByOrg(context.org.id);
      res.json({
        invites: invites.map((invite) => ({
          inviteId: invite.inviteId,
          githubLogin: invite.githubLogin,
          createdAt: invite.createdAt
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/orgs/:slug/tokens', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      const tokens = await deps.orgTokens.listOrgTokens(context.org.id);
      res.json({ tokens });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/tokens', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      const body = addTokenSchema.parse(req.body ?? {});
      const created = await deps.orgTokenManagement.addOrgToken({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        provider: body.provider,
        ...(body.debugLabel ? { debugLabel: body.debugLabel } : {}),
        token: body.token,
        refreshToken: body.refreshToken,
        fiveHourReservePercent: body.fiveHourReservePercent,
        sevenDayReservePercent: body.sevenDayReservePercent
      });
      res.json({ tokenId: created.tokenId });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/tokens/:tokenId/reserve-floors', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      assertOwner(context.membership.isOwner);
      const body = updateTokenReserveSchema.parse(req.body ?? {});
      const updated = await deps.orgTokenManagement.updateOrgTokenReserve({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        tokenId: String(req.params.tokenId ?? ''),
        fiveHourReservePercent: body.fiveHourReservePercent as number,
        sevenDayReservePercent: body.sevenDayReservePercent as number
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/tokens/:tokenId/probe', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      assertOwner(context.membership.isOwner);
      const probe = await deps.orgTokenManagement.probeOrgToken({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        tokenId: String(req.params.tokenId ?? '')
      });
      res.json(probe);
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/tokens/:tokenId/refresh', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      await deps.orgTokenManagement.refreshOrgToken({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        tokenId: String(req.params.tokenId ?? '')
      });
      res.json({
        tokenId: String(req.params.tokenId ?? ''),
        status: 'refreshed'
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/tokens/:tokenId/remove', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const context = await resolveActiveMembershipContext(req as never, deps);
      await deps.orgTokenManagement.removeOrgToken({
        orgSlug: context.effectiveOrgSlug,
        actorUserId: context.session.actorUserId,
        tokenId: String(req.params.tokenId ?? '')
      });
      res.json({
        tokenId: String(req.params.tokenId ?? ''),
        status: 'removed'
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/leave', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const session = req.orgSession;
      if (!session) {
        throw new AppError('unauthorized', 401, 'Missing org session');
      }
      const resolved = await resolveOrgRouteSlug({
        routeSlug: String(req.params.slug ?? ''),
        findOrgBySlug: (slug) => deps.orgAccess.findOrgBySlug(slug)
      });
      if (!resolved) {
        const routeSlug = String(req.params.slug ?? '').trim().toLowerCase();
        throw new AppError('not_found', 404, `Org not found: ${routeSlug}`);
      }
      const result = await deps.orgMemberships.leaveOrg({
        orgSlug: resolved.effectiveOrgSlug,
        actorUserId: session.actorUserId
      });
      res.json({
        membershipId: result.membershipId,
        redirectTo: '/'
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v1/orgs/:slug/members/:memberUserId/remove', requireOrgSession(deps.orgSessions), async (req, res, next) => {
    try {
      const session = req.orgSession;
      if (!session) {
        throw new AppError('unauthorized', 401, 'Missing org session');
      }
      const resolved = await resolveOrgRouteSlug({
        routeSlug: String(req.params.slug ?? ''),
        findOrgBySlug: (slug) => deps.orgAccess.findOrgBySlug(slug)
      });
      if (!resolved) {
        const routeSlug = String(req.params.slug ?? '').trim().toLowerCase();
        throw new AppError('not_found', 404, `Org not found: ${routeSlug}`);
      }
      const result = await deps.orgMemberships.removeMember({
        orgSlug: resolved.effectiveOrgSlug,
        actorUserId: session.actorUserId,
        memberUserId: String(req.params.memberUserId ?? '')
      });
      res.json({
        membershipId: result.membershipId
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createOrgManagementRouter({
  orgSessions: runtime.services.orgSessions,
  orgAccess: runtime.repos.orgAccess,
  orgInvites: runtime.repos.orgInvites,
  orgTokens: runtime.repos.orgTokens,
  orgMemberships: runtime.services.orgMemberships,
  orgTokenManagement: runtime.services.orgTokenManagement
});
