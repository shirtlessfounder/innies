import { type IdFactory, uuidV4 } from '../../repos/idFactory.js';
import {
  OrgAccessRepository
} from '../../repos/orgAccessRepository.js';
import { OrgBuyerKeyRepository } from '../../repos/orgBuyerKeyRepository.js';
import {
  AlreadyActiveOrgMemberError,
  OrgInviteRepository
} from '../../repos/orgInviteRepository.js';
import { OrgTokenRepository } from '../../repos/orgTokenRepository.js';
import type { SqlClient, TransactionContext } from '../../repos/sqlClient.js';
import { AppError } from '../../utils/errors.js';
import { assertOrgSlugAllowed, normalizeOrgSlug } from './orgSlug.js';

type OrgAccessRepositoryLike = Pick<
  OrgAccessRepository,
  'createOrgWithOwner' | 'findOrgBySlug' | 'activateMembership' | 'listMembers'
>;

type OrgInviteRepositoryLike = Pick<
  OrgInviteRepository,
  'createOrRefreshPendingInvite' | 'listPendingByOrg' | 'markAccepted' | 'markRevoked'
>;

type OrgBuyerKeyRepositoryLike = Pick<
  OrgBuyerKeyRepository,
  'createMembershipBuyerKey' | 'revokeMembershipBuyerKey'
>;

type OrgTokenRepositoryLike = Pick<
  OrgTokenRepository,
  'removeMemberTokens'
>;

type RepositoryBundle = {
  orgAccess: OrgAccessRepositoryLike;
  orgInvites: OrgInviteRepositoryLike;
  orgBuyerKeys: OrgBuyerKeyRepositoryLike;
  orgTokens: OrgTokenRepositoryLike;
};

type BuildRepositories = (client: SqlClient | TransactionContext) => RepositoryBundle;

function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

function defaultBuildRepositories(input: {
  createId: IdFactory;
}): BuildRepositories {
  return (client) => ({
    orgAccess: new OrgAccessRepository(client as SqlClient),
    orgInvites: new OrgInviteRepository(client as SqlClient),
    orgBuyerKeys: new OrgBuyerKeyRepository(client as SqlClient, input.createId),
    orgTokens: new OrgTokenRepository(client as SqlClient)
  });
}

async function defaultEndMembership(
  tx: TransactionContext,
  membershipId: string
): Promise<void> {
  await tx.query(
    'update in_memberships set ended_at = now() where id = $1 and ended_at is null',
    [membershipId]
  );
}

export class OrgMembershipService {
  private readonly createId: IdFactory;
  private readonly buildRepositories: BuildRepositories;
  private readonly endMembership: (
    tx: TransactionContext,
    membershipId: string
  ) => Promise<void>;

  constructor(private readonly input: {
    sql: SqlClient;
    createId?: IdFactory;
    buildRepositories?: BuildRepositories;
    endMembership?: (
      tx: TransactionContext,
      membershipId: string
    ) => Promise<void>;
  }) {
    this.createId = input.createId ?? uuidV4;
    this.buildRepositories = input.buildRepositories ?? defaultBuildRepositories({
      createId: this.createId
    });
    this.endMembership = input.endMembership ?? defaultEndMembership;
  }

  async createOrg(input: {
    orgName: string;
    actorUserId: string;
    actorGithubLogin: string;
  }): Promise<{ orgId: string; orgSlug: string; reveal: { buyerKey: string; reason: 'org_created' } }> {
    const orgSlug = this.normalizeAndValidateOrgSlug(input.orgName);
    const _actorGithubLogin = input.actorGithubLogin;
    void _actorGithubLogin;

    const existingOrg = await this.rootRepos().orgAccess.findOrgBySlug(orgSlug);
    if (existingOrg) {
      throw new AppError('invalid_request', 409, `Org slug already exists: ${orgSlug}`);
    }

    return this.input.sql.transaction(async (tx) => {
      const repos = this.txRepos(tx);
      const orgId = this.createId();
      const ownerMembershipId = this.createId();

      await repos.orgAccess.createOrgWithOwner({
        orgId,
        orgName: input.orgName,
        orgSlug,
        ownerUserId: input.actorUserId,
        ownerMembershipId
      });

      const buyerKey = await repos.orgBuyerKeys.createMembershipBuyerKey(tx, {
        membershipId: ownerMembershipId,
        orgId,
        userId: input.actorUserId
      });

      return {
        orgId,
        orgSlug,
        reveal: {
          buyerKey: buyerKey.plaintextKey,
          reason: 'org_created' as const
        }
      };
    });
  }

  async createInvite(input: {
    orgSlug: string;
    actorUserId: string;
    githubLogin: string;
  }): Promise<
    | { kind: 'invite_created'; inviteId: string; createdFresh: boolean }
    | { kind: 'already_a_member' }
  > {
    const org = await this.requireOrg(input.orgSlug);
    this.assertOwner(org.ownerUserId, input.actorUserId);

    return this.input.sql.transaction(async (tx) => {
      const repos = this.txRepos(tx);

      try {
        const created = await repos.orgInvites.createOrRefreshPendingInvite({
          inviteId: this.createId(),
          orgId: org.id,
          githubLogin: input.githubLogin,
          createdByUserId: input.actorUserId
        });

        return {
          kind: 'invite_created' as const,
          inviteId: created.inviteId,
          createdFresh: created.createdFresh
        };
      } catch (error) {
        if (error instanceof AlreadyActiveOrgMemberError) {
          return { kind: 'already_a_member' as const };
        }
        throw error;
      }
    });
  }

  async revokeInvite(input: {
    orgSlug: string;
    actorUserId: string;
    inviteId: string;
  }): Promise<void> {
    const org = await this.requireOrg(input.orgSlug);
    this.assertOwner(org.ownerUserId, input.actorUserId);

    await this.input.sql.transaction(async (tx) => {
      const repos = this.txRepos(tx);
      const pendingInvites = await repos.orgInvites.listPendingByOrg(org.id);
      const invite = pendingInvites.find((entry) => entry.inviteId === input.inviteId);
      if (!invite) {
        return;
      }
      await repos.orgInvites.markRevoked({
        inviteId: invite.inviteId,
        revokedByUserId: input.actorUserId
      });
    });
  }

  async acceptInvite(input: {
    orgSlug: string;
    actorUserId: string;
    actorGithubLogin: string;
  }): Promise<
    | { kind: 'invite_accepted'; membershipId: string; reveal: { buyerKey: string; reason: 'invite_accepted' } }
    | { kind: 'already_active_member'; membershipId: string }
    | { kind: 'invite_no_longer_valid' }
  > {
    const org = await this.requireOrg(input.orgSlug);
    const normalizedGithubLogin = normalizeGithubLogin(input.actorGithubLogin);

    return this.input.sql.transaction(async (tx) => {
      const repos = this.txRepos(tx);
      const activeMembership = (await repos.orgAccess.listMembers(org.id))
        .find((entry) => entry.userId === input.actorUserId);
      if (activeMembership) {
        return {
          kind: 'already_active_member' as const,
          membershipId: activeMembership.membershipId
        };
      }

      const pendingInvite = (await repos.orgInvites.listPendingByOrg(org.id))
        .find((entry) => entry.githubLogin === normalizedGithubLogin);

      if (!pendingInvite) {
        return { kind: 'invite_no_longer_valid' as const };
      }

      const membership = await repos.orgAccess.activateMembership({
        orgId: org.id,
        userId: input.actorUserId,
        membershipId: this.createId()
      });

      const buyerKey = await repos.orgBuyerKeys.createMembershipBuyerKey(tx, {
        membershipId: membership.membershipId,
        orgId: org.id,
        userId: input.actorUserId
      });

      await repos.orgInvites.markAccepted({
        inviteId: pendingInvite.inviteId,
        acceptedByUserId: input.actorUserId
      });

      return {
        kind: 'invite_accepted' as const,
        membershipId: membership.membershipId,
        reveal: {
          buyerKey: buyerKey.plaintextKey,
          reason: 'invite_accepted' as const
        }
      };
    });
  }

  async leaveOrg(input: {
    orgSlug: string;
    actorUserId: string;
  }): Promise<{ membershipId: string }> {
    const org = await this.requireOrg(input.orgSlug);
    const actorMembership = await this.requireActiveMembership(org.id, input.actorUserId);

    if (actorMembership.isOwner) {
      throw new AppError('invalid_request', 409, 'Owner cannot leave the org');
    }

    return this.input.sql.transaction(async (tx) => {
      const repos = this.txRepos(tx);
      await repos.orgBuyerKeys.revokeMembershipBuyerKey(tx, actorMembership.membershipId);
      await repos.orgTokens.removeMemberTokens(tx, org.id, input.actorUserId);
      await this.endMembership(tx, actorMembership.membershipId);
      return { membershipId: actorMembership.membershipId };
    });
  }

  async removeMember(input: {
    orgSlug: string;
    actorUserId: string;
    memberUserId: string;
  }): Promise<{ membershipId: string }> {
    const org = await this.requireOrg(input.orgSlug);
    this.assertOwner(org.ownerUserId, input.actorUserId);

    if (input.memberUserId === org.ownerUserId) {
      throw new AppError('invalid_request', 409, 'Owner cannot remove their own owner membership');
    }

    const membership = await this.requireActiveMembership(org.id, input.memberUserId);

    return this.input.sql.transaction(async (tx) => {
      const repos = this.txRepos(tx);
      await repos.orgBuyerKeys.revokeMembershipBuyerKey(tx, membership.membershipId);
      await repos.orgTokens.removeMemberTokens(tx, org.id, input.memberUserId);
      await this.endMembership(tx, membership.membershipId);
      return { membershipId: membership.membershipId };
    });
  }

  private rootRepos(): RepositoryBundle {
    return this.buildRepositories(this.input.sql);
  }

  private txRepos(tx: TransactionContext): RepositoryBundle {
    return this.buildRepositories(tx);
  }

  private normalizeAndValidateOrgSlug(orgName: string): string {
    try {
      const orgSlug = normalizeOrgSlug(orgName);
      assertOrgSlugAllowed(orgSlug);
      return orgSlug;
    } catch (error) {
      throw new AppError(
        'invalid_request',
        409,
        error instanceof Error ? error.message : 'Org slug is invalid'
      );
    }
  }

  private async requireOrg(orgSlug: string): Promise<{
    id: string;
    slug: string;
    name: string;
    ownerUserId: string;
  }> {
    const org = await this.rootRepos().orgAccess.findOrgBySlug(orgSlug);
    if (!org) {
      throw new AppError('not_found', 404, `Org not found: ${orgSlug}`);
    }
    return org;
  }

  private assertOwner(ownerUserId: string, actorUserId: string): void {
    if (ownerUserId !== actorUserId) {
      throw new AppError('forbidden', 403, 'Only the org owner can perform this action');
    }
  }

  private async requireActiveMembership(orgId: string, userId: string): Promise<{
    userId: string;
    githubLogin: string | null;
    membershipId: string;
    isOwner: boolean;
  }> {
    const membership = (await this.rootRepos().orgAccess.listMembers(orgId))
      .find((entry) => entry.userId === userId);

    if (!membership) {
      throw new AppError('forbidden', 403, 'Active org membership is required');
    }

    return membership;
  }
}
