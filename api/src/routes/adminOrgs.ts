import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import type { OrgAccessRepository } from '../repos/orgAccessRepository.js';
import type { OrgInviteRepository } from '../repos/orgInviteRepository.js';
import type { OrgBuyerKeyRepository } from '../repos/orgBuyerKeyRepository.js';
import type { OrgTokenRepository } from '../repos/orgTokenRepository.js';
import { runtime } from '../services/runtime.js';
import { AppError } from '../utils/errors.js';

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
};

type AdminOrgAccessRepo = Pick<OrgAccessRepository, 'findOrgBySlug' | 'listMembers' | 'listOrgs'>;
type AdminOrgInviteRepo = Pick<OrgInviteRepository, 'listPendingByOrg'>;
type AdminOrgTokenRepo = Pick<OrgTokenRepository, 'listOrgTokens'>;
type AdminOrgBuyerKeyRepo = Pick<OrgBuyerKeyRepository, 'listOrgKeysWithMembers' | 'rotateMembershipBuyerKey'> & {
  revokeBuyerKeyById?: (apiKeyId: string) => Promise<void>;
  db?: Queryable;
};

type AdminOrgsRouteDeps = {
  apiKeys: ApiKeyRepository;
  orgAccess: AdminOrgAccessRepo;
  orgInvites: AdminOrgInviteRepo;
  orgBuyerKeys: AdminOrgBuyerKeyRepo;
  orgTokens: AdminOrgTokenRepo;
};

const slugParamsSchema = z.object({
  slug: z.string().trim().min(1)
});

const revokeBuyerKeyParamsSchema = slugParamsSchema.extend({
  apiKeyId: z.string().trim().min(1)
});

const rotateBuyerKeyParamsSchema = slugParamsSchema.extend({
  membershipId: z.string().trim().min(1)
});

async function findOrgOrThrow(orgAccess: AdminOrgAccessRepo, slug: string) {
  const org = await orgAccess.findOrgBySlug(slug);
  if (!org) {
    throw new AppError('not_found', 404, 'Org not found');
  }
  return org;
}

async function revokeBuyerKeyById(
  orgBuyerKeys: AdminOrgBuyerKeyRepo,
  apiKeyId: string
): Promise<void> {
  if (typeof orgBuyerKeys.revokeBuyerKeyById === 'function') {
    await orgBuyerKeys.revokeBuyerKeyById(apiKeyId);
    return;
  }

  if (orgBuyerKeys.db && typeof orgBuyerKeys.db.query === 'function') {
    await orgBuyerKeys.db.query(
      `update in_api_keys set revoked_at = now() where id = $1 and revoked_at is null`,
      [apiKeyId]
    );
    return;
  }

  throw new Error('revokeBuyerKeyById is unavailable');
}

export function createAdminOrgsRouter(deps: AdminOrgsRouteDeps): Router {
  const router = Router();
  const requireAdmin = requireApiKey(deps.apiKeys, ['admin']);

  router.get('/orgs', requireAdmin, async (_req, res, next) => {
    try {
      const orgs = await deps.orgAccess.listOrgs();
      res.status(200).json({ orgs });
    } catch (error) {
      next(error);
    }
  });

  router.get('/orgs/:slug/members', requireAdmin, async (req, res, next) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const org = await findOrgOrThrow(deps.orgAccess, slug);
      const members = await deps.orgAccess.listMembers(org.id);
      res.status(200).json({ members });
    } catch (error) {
      next(error);
    }
  });

  router.get('/orgs/:slug/invites', requireAdmin, async (req, res, next) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const org = await findOrgOrThrow(deps.orgAccess, slug);
      const invites = await deps.orgInvites.listPendingByOrg(org.id);
      res.status(200).json({ invites });
    } catch (error) {
      next(error);
    }
  });

  router.get('/orgs/:slug/buyer-keys', requireAdmin, async (req, res, next) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const org = await findOrgOrThrow(deps.orgAccess, slug);
      const buyerKeys = await deps.orgBuyerKeys.listOrgKeysWithMembers(org.id);
      res.status(200).json({ buyerKeys });
    } catch (error) {
      next(error);
    }
  });

  router.get('/orgs/:slug/tokens', requireAdmin, async (req, res, next) => {
    try {
      const { slug } = slugParamsSchema.parse(req.params);
      const org = await findOrgOrThrow(deps.orgAccess, slug);
      const tokens = await deps.orgTokens.listOrgTokens(org.id);
      res.status(200).json({ tokens });
    } catch (error) {
      next(error);
    }
  });

  router.post('/orgs/:slug/buyer-keys/:apiKeyId/revoke', requireAdmin, async (req, res, next) => {
    try {
      const { slug, apiKeyId } = revokeBuyerKeyParamsSchema.parse(req.params);
      const org = await findOrgOrThrow(deps.orgAccess, slug);
      const buyerKeys = await deps.orgBuyerKeys.listOrgKeysWithMembers(org.id);
      const buyerKey = buyerKeys.find((entry) => entry.apiKeyId === apiKeyId);

      if (!buyerKey) {
        throw new AppError('not_found', 404, 'Buyer key not found');
      }

      await revokeBuyerKeyById(deps.orgBuyerKeys, buyerKey.apiKeyId);
      res.status(200).json({
        apiKeyId: buyerKey.apiKeyId,
        status: 'revoked'
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/orgs/:slug/members/:membershipId/buyer-key/rotate', requireAdmin, async (req, res, next) => {
    try {
      const { slug, membershipId } = rotateBuyerKeyParamsSchema.parse(req.params);
      const org = await findOrgOrThrow(deps.orgAccess, slug);
      const members = await deps.orgAccess.listMembers(org.id);
      const member = members.find((entry) => entry.membershipId === membershipId);

      if (!member) {
        throw new AppError('not_found', 404, 'Membership not found');
      }

      const rotated = await deps.orgBuyerKeys.rotateMembershipBuyerKey({
        membershipId: member.membershipId,
        orgId: org.id,
        userId: member.userId
      });

      res.status(200).json({
        membershipId: member.membershipId,
        apiKeyId: rotated.apiKeyId,
        plaintextKey: rotated.plaintextKey
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAdminOrgsRouter({
  apiKeys: runtime.repos.apiKeys,
  orgAccess: runtime.repos.orgAccess,
  orgInvites: runtime.repos.orgInvites,
  orgBuyerKeys: runtime.repos.orgBuyerKeys as unknown as AdminOrgBuyerKeyRepo,
  orgTokens: runtime.repos.orgTokens
});
