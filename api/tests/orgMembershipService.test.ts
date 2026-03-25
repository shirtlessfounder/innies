import { describe, expect, it } from 'vitest';
import { AlreadyActiveOrgMemberError } from '../src/repos/orgInviteRepository.js';
import { OrgMembershipService } from '../src/services/org/orgMembershipService.js';

type HarnessState = {
  orgs: Array<{ id: string; slug: string; name: string; ownerUserId: string }>;
  users: Record<string, string | null>;
  memberships: Array<{ membershipId: string; orgId: string; userId: string; endedAt: string | null }>;
  invites: Array<{
    inviteId: string;
    orgId: string;
    githubLogin: string;
    createdByUserId: string;
    status: 'pending' | 'revoked' | 'accepted';
    createdAt: string;
  }>;
  buyerKeys: Array<{
    apiKeyId: string;
    membershipId: string;
    orgId: string;
    userId: string;
    plaintextKey: string;
    revoked: boolean;
  }>;
  removedTokens: Array<{ orgId: string; userId: string }>;
  failCreateBuyerKey?: boolean;
  failRevokeBuyerKey?: boolean;
  failRemoveTokens?: boolean;
};

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function createHarness(input?: {
  state?: Partial<HarnessState>;
  ids?: string[];
}) {
  let state: HarnessState = {
    orgs: [],
    users: {},
    memberships: [],
    invites: [],
    buyerKeys: [],
    removedTokens: [],
    ...input?.state
  };

  let nextId = 0;
  const createId = () => input?.ids?.[nextId++] ?? `generated_${++nextId}`;

  const buildRepositories = (client: { __state?: HarnessState }) => {
    const repoState = client.__state ?? state;

    return {
      orgAccess: {
        async createOrgWithOwner(value: {
          orgId: string;
          orgName: string;
          orgSlug: string;
          ownerUserId: string;
          ownerMembershipId: string;
        }) {
          repoState.orgs.push({
            id: value.orgId,
            slug: value.orgSlug,
            name: value.orgName,
            ownerUserId: value.ownerUserId
          });
          repoState.memberships.push({
            membershipId: value.ownerMembershipId,
            orgId: value.orgId,
            userId: value.ownerUserId,
            endedAt: null
          });
        },
        async findOrgBySlug(slug: string) {
          const org = repoState.orgs.find((entry) => entry.slug === slug);
          if (!org) return null;
          return {
            id: org.id,
            slug: org.slug,
            name: org.name,
            ownerUserId: org.ownerUserId
          };
        },
        async findActiveOrgByUserId(userId: string) {
          const activeMembership = repoState.memberships.find((entry) => entry.userId === userId && entry.endedAt === null);
          if (!activeMembership) return null;

          const org = repoState.orgs.find((entry) => entry.id === activeMembership.orgId);
          if (!org) return null;

          return {
            id: org.id,
            slug: org.slug,
            name: org.name,
            ownerUserId: org.ownerUserId
          };
        },
        async activateMembership(value: {
          orgId: string;
          userId: string;
          membershipId: string;
        }) {
          const existing = repoState.memberships.find((entry) => entry.orgId === value.orgId && entry.userId === value.userId);
          if (existing) {
            const reactivated = existing.endedAt !== null;
            existing.endedAt = null;
            return { membershipId: existing.membershipId, reactivated };
          }

          repoState.memberships.push({
            membershipId: value.membershipId,
            orgId: value.orgId,
            userId: value.userId,
            endedAt: null
          });
          return { membershipId: value.membershipId, reactivated: false };
        },
        async listMembers(orgId: string) {
          const org = repoState.orgs.find((entry) => entry.id === orgId);
          return repoState.memberships
            .filter((entry) => entry.orgId === orgId && entry.endedAt === null)
            .map((entry) => ({
              userId: entry.userId,
              githubLogin: repoState.users[entry.userId] ?? null,
              membershipId: entry.membershipId,
              isOwner: org?.ownerUserId === entry.userId
            }));
        }
      },
      orgInvites: {
        async createOrRefreshPendingInvite(value: {
          inviteId: string;
          orgId: string;
          githubLogin: string;
          createdByUserId: string;
        }) {
          const normalized = normalizeLogin(value.githubLogin);
          const hasActiveMember = repoState.memberships.some((entry) => (
            entry.orgId === value.orgId
            && entry.endedAt === null
            && repoState.users[entry.userId] === normalized
          ));

          if (hasActiveMember) {
            throw new AlreadyActiveOrgMemberError(value.orgId, normalized);
          }

          const existingPending = repoState.invites.find((entry) => (
            entry.orgId === value.orgId
            && entry.githubLogin === normalized
            && entry.status === 'pending'
          ));

          if (existingPending) {
            existingPending.createdByUserId = value.createdByUserId;
            return { inviteId: existingPending.inviteId, createdFresh: false };
          }

          repoState.invites.push({
            inviteId: value.inviteId,
            orgId: value.orgId,
            githubLogin: normalized,
            createdByUserId: value.createdByUserId,
            status: 'pending',
            createdAt: '2026-03-24T00:00:00.000Z'
          });
          return { inviteId: value.inviteId, createdFresh: true };
        },
        async listPendingByOrg(orgId: string) {
          return repoState.invites
            .filter((entry) => entry.orgId === orgId && entry.status === 'pending')
            .map((entry) => ({
              inviteId: entry.inviteId,
              githubLogin: entry.githubLogin,
              createdAt: entry.createdAt,
              createdByUserId: entry.createdByUserId
            }));
        },
        async markAccepted(value: {
          inviteId: string;
          acceptedByUserId: string;
        }) {
          const invite = repoState.invites.find((entry) => entry.inviteId === value.inviteId);
          if (invite) {
            invite.status = 'accepted';
          }
        },
        async markRevoked(value: {
          inviteId: string;
          revokedByUserId: string;
        }) {
          const invite = repoState.invites.find((entry) => entry.inviteId === value.inviteId);
          if (invite) {
            invite.status = 'revoked';
          }
        }
      },
      orgBuyerKeys: {
        async createMembershipBuyerKey(
          tx: { __state?: HarnessState },
          value: { membershipId: string; orgId: string; userId: string }
        ) {
          const txState = tx.__state ?? repoState;
          if (txState.failCreateBuyerKey) {
            throw new Error('buyer-key-create-failed');
          }
          const plaintextKey = `in_live_${value.membershipId}`;
          txState.buyerKeys.push({
            apiKeyId: `api_${value.membershipId}`,
            membershipId: value.membershipId,
            orgId: value.orgId,
            userId: value.userId,
            plaintextKey,
            revoked: false
          });
          return { apiKeyId: `api_${value.membershipId}`, plaintextKey };
        },
        async revokeMembershipBuyerKey(
          tx: { __state?: HarnessState },
          membershipId: string
        ) {
          const txState = tx.__state ?? repoState;
          if (txState.failRevokeBuyerKey) {
            throw new Error('buyer-key-revoke-failed');
          }
          txState.buyerKeys
            .filter((entry) => entry.membershipId === membershipId && !entry.revoked)
            .forEach((entry) => {
              entry.revoked = true;
            });
        }
      },
      orgTokens: {
        async removeMemberTokens(
          tx: { __state?: HarnessState },
          orgId: string,
          userId: string
        ) {
          const txState = tx.__state ?? repoState;
          if (txState.failRemoveTokens) {
            throw new Error('remove-member-tokens-failed');
          }
          txState.removedTokens.push({ orgId, userId });
          return 1;
        }
      }
    };
  };

  const sql = {
    __state: state,
    async query<T = Record<string, unknown>>(_sql: string, _params?: unknown[]) {
      return { rows: [] as T[], rowCount: 0 };
    },
    async transaction<T>(run: (tx: { __state: HarnessState; query: typeof sql.query }) => Promise<T>) {
      const txState = cloneState(state);
      const tx = {
        __state: txState,
        async query<T = Record<string, unknown>>(sqlText: string, params?: unknown[]) {
          if (sqlText.includes('update in_memberships set ended_at = now()')) {
            const membership = txState.memberships.find((entry) => entry.membershipId === params?.[0]);
            if (membership) {
              membership.endedAt = '2026-03-24T00:00:00.000Z';
              return { rows: [] as T[], rowCount: 1 };
            }
            return { rows: [] as T[], rowCount: 0 };
          }
          throw new Error(`Unexpected query: ${sqlText}`);
        }
      };

      const result = await run(tx);
      state = txState;
      sql.__state = state;
      return result;
    }
  };

  const service = new OrgMembershipService({
    sql: sql as any,
    createId,
    buildRepositories
  });

  return {
    service,
    getState: () => state
  };
}

describe('OrgMembershipService', () => {
  it('creates the org in one transaction and rolls back if buyer-key creation fails', async () => {
    const harness = createHarness({
      ids: ['org_1', 'membership_owner'],
      state: {
        users: { user_owner: 'shipit' },
        failCreateBuyerKey: true
      }
    });

    await expect(harness.service.createOrg({
      orgName: 'Launch Team',
      actorUserId: 'user_owner',
      actorGithubLogin: 'ShipIt'
    })).rejects.toThrow('buyer-key-create-failed');

    expect(harness.getState().orgs).toEqual([]);
    expect(harness.getState().memberships).toEqual([]);
    expect(harness.getState().buyerKeys).toEqual([]);
  });

  it('rejects reserved and already-taken slugs on org creation', async () => {
    const reservedHarness = createHarness({
      state: {
        users: { user_owner: 'shipit' }
      }
    });

    await expect(reservedHarness.service.createOrg({
      orgName: 'Innies',
      actorUserId: 'user_owner',
      actorGithubLogin: 'shipit'
    })).rejects.toThrow('reserved');

    const takenHarness = createHarness({
      state: {
        users: { user_owner: 'shipit' },
        orgs: [{ id: 'org_existing', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_other' }]
      }
    });

    await expect(takenHarness.service.createOrg({
      orgName: 'Launch Team',
      actorUserId: 'user_owner',
      actorGithubLogin: 'shipit'
    })).rejects.toThrow('already exists');
  });

  it('allows org creation while the actor is already active in another org', async () => {
    const harness = createHarness({
      ids: ['org_2', 'membership_new_org'],
      state: {
        users: { user_owner: 'shipit' },
        orgs: [{ id: 'org_existing', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_other' }],
        memberships: [
          { membershipId: 'membership_existing', orgId: 'org_existing', userId: 'user_owner', endedAt: null }
        ]
      }
    });

    await expect(harness.service.createOrg({
      orgName: 'Second Org',
      actorUserId: 'user_owner',
      actorGithubLogin: 'shipit'
    })).resolves.toEqual({
      orgId: 'org_2',
      orgSlug: 'second-org',
      reveal: {
        buyerKey: 'in_live_membership_new_org',
        reason: 'org_created'
      }
    });

    expect(harness.getState().orgs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'org_existing', slug: 'launch-team' }),
      expect.objectContaining({ id: 'org_2', slug: 'second-org', ownerUserId: 'user_owner' })
    ]));
    expect(harness.getState().memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: 'membership_existing', orgId: 'org_existing', userId: 'user_owner' }),
      expect.objectContaining({ membershipId: 'membership_new_org', orgId: 'org_2', userId: 'user_owner', endedAt: null })
    ]));
  });

  it('returns already_a_member when the invite login already has an active membership', async () => {
    const harness = createHarness({
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'invited-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null },
          { membershipId: 'membership_member', orgId: 'org_1', userId: 'user_member', endedAt: null }
        ]
      }
    });

    await expect(harness.service.createInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner',
      githubLogin: 'Invited-User'
    })).resolves.toEqual({ kind: 'already_a_member' });
  });

  it('re-whitelists revoked and accepted logins by creating a fresh pending row', async () => {
    for (const status of ['revoked', 'accepted'] as const) {
      const harness = createHarness({
        ids: ['invite_fresh'],
        state: {
          orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
          users: { user_owner: 'shipit' },
          memberships: [
            { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null }
          ],
          invites: [{
            inviteId: `invite_${status}`,
            orgId: 'org_1',
            githubLogin: 'returning-user',
            createdByUserId: 'user_owner',
            status,
            createdAt: '2026-03-20T00:00:00.000Z'
          }]
        }
      });

      await expect(harness.service.createInvite({
        orgSlug: 'launch-team',
        actorUserId: 'user_owner',
        githubLogin: 'Returning-User'
      })).resolves.toEqual({
        kind: 'invite_created',
        inviteId: 'invite_fresh',
        createdFresh: true
      });

      expect(harness.getState().invites).toEqual(expect.arrayContaining([
        expect.objectContaining({ inviteId: `invite_${status}`, status }),
        expect.objectContaining({ inviteId: 'invite_fresh', status: 'pending', githubLogin: 'returning-user' })
      ]));
    }
  });

  it('accepts a pending invite atomically and returns the fresh buyer-key reveal', async () => {
    const harness = createHarness({
      ids: ['membership_new'],
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'invited-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null }
        ],
        invites: [{
          inviteId: 'invite_1',
          orgId: 'org_1',
          githubLogin: 'invited-user',
          createdByUserId: 'user_owner',
          status: 'pending',
          createdAt: '2026-03-20T00:00:00.000Z'
        }]
      }
    });

    await expect(harness.service.acceptInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      actorGithubLogin: 'Invited-User'
    })).resolves.toEqual({
      kind: 'invite_accepted',
      membershipId: 'membership_new',
      reveal: {
        buyerKey: 'in_live_membership_new',
        reason: 'invite_accepted'
      }
    });

    expect(harness.getState().memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        membershipId: 'membership_new',
        orgId: 'org_1',
        userId: 'user_member',
        endedAt: null
      })
    ]));
    expect(harness.getState().invites).toEqual(expect.arrayContaining([
      expect.objectContaining({ inviteId: 'invite_1', status: 'accepted' })
    ]));
    expect(harness.getState().buyerKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: 'membership_new', revoked: false })
    ]));
  });

  it('rolls back invite acceptance cleanly if buyer-key creation fails', async () => {
    const harness = createHarness({
      ids: ['membership_new'],
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'invited-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null }
        ],
        invites: [{
          inviteId: 'invite_1',
          orgId: 'org_1',
          githubLogin: 'invited-user',
          createdByUserId: 'user_owner',
          status: 'pending',
          createdAt: '2026-03-20T00:00:00.000Z'
        }],
        failCreateBuyerKey: true
      }
    });

    await expect(harness.service.acceptInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      actorGithubLogin: 'Invited-User'
    })).rejects.toThrow('buyer-key-create-failed');

    expect(harness.getState().memberships).toHaveLength(1);
    expect(harness.getState().invites).toEqual([
      expect.objectContaining({ inviteId: 'invite_1', status: 'pending' })
    ]);
    expect(harness.getState().buyerKeys).toEqual([]);
  });

  it('treats duplicate acceptance for an active membership as an idempotent success', async () => {
    const harness = createHarness({
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'invited-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null },
          { membershipId: 'membership_member', orgId: 'org_1', userId: 'user_member', endedAt: null }
        ]
      }
    });

    await expect(harness.service.acceptInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      actorGithubLogin: 'Invited-User'
    })).resolves.toEqual({
      kind: 'already_active_member',
      membershipId: 'membership_member'
    });

    expect(harness.getState().buyerKeys).toEqual([]);
  });

  it('returns invite_no_longer_valid when the pending invite is gone before submit', async () => {
    const harness = createHarness({
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'invited-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null }
        ],
        invites: [{
          inviteId: 'invite_1',
          orgId: 'org_1',
          githubLogin: 'invited-user',
          createdByUserId: 'user_owner',
          status: 'revoked',
          createdAt: '2026-03-20T00:00:00.000Z'
        }]
      }
    });

    await expect(harness.service.acceptInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      actorGithubLogin: 'Invited-User'
    })).resolves.toEqual({ kind: 'invite_no_longer_valid' });
  });

  it('accepts an invite while the actor remains active in another org', async () => {
    const harness = createHarness({
      ids: ['membership_new'],
      state: {
        orgs: [
          { id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' },
          { id: 'org_2', slug: 'second-team', name: 'Second Team', ownerUserId: 'user_other' }
        ],
        users: {
          user_owner: 'shipit',
          user_other: 'other-owner',
          user_member: 'invited-user'
        },
        memberships: [
          { membershipId: 'membership_second', orgId: 'org_2', userId: 'user_member', endedAt: null }
        ],
        invites: [{
          inviteId: 'invite_1',
          orgId: 'org_1',
          githubLogin: 'invited-user',
          createdByUserId: 'user_owner',
          status: 'pending',
          createdAt: '2026-03-20T00:00:00.000Z'
        }]
      }
    });

    await expect(harness.service.acceptInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      actorGithubLogin: 'Invited-User'
    })).resolves.toEqual({
      kind: 'invite_accepted',
      membershipId: 'membership_new',
      reveal: {
        buyerKey: 'in_live_membership_new',
        reason: 'invite_accepted'
      }
    });

    expect(harness.getState().memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: 'membership_second', orgId: 'org_2', userId: 'user_member', endedAt: null }),
      expect.objectContaining({ membershipId: 'membership_new', orgId: 'org_1', userId: 'user_member', endedAt: null })
    ]));
    expect(harness.getState().buyerKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: 'membership_new', orgId: 'org_1', userId: 'user_member', revoked: false })
    ]));
  });

  it('reactivates an ended membership on the same row and issues a fresh buyer key', async () => {
    const harness = createHarness({
      ids: ['ignored_new_membership_id'],
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'returning-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null },
          { membershipId: 'membership_old', orgId: 'org_1', userId: 'user_member', endedAt: '2026-03-20T00:00:00.000Z' }
        ],
        invites: [{
          inviteId: 'invite_1',
          orgId: 'org_1',
          githubLogin: 'returning-user',
          createdByUserId: 'user_owner',
          status: 'pending',
          createdAt: '2026-03-20T00:00:00.000Z'
        }],
        buyerKeys: [{
          apiKeyId: 'api_old',
          membershipId: 'membership_old',
          orgId: 'org_1',
          userId: 'user_member',
          plaintextKey: 'in_live_membership_old_old',
          revoked: true
        }]
      }
    });

    await expect(harness.service.acceptInvite({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      actorGithubLogin: 'Returning-User'
    })).resolves.toEqual({
      kind: 'invite_accepted',
      membershipId: 'membership_old',
      reveal: {
        buyerKey: 'in_live_membership_old',
        reason: 'invite_accepted'
      }
    });

    expect(harness.getState().memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: 'membership_old', endedAt: null })
    ]));
    expect(harness.getState().buyerKeys.filter((entry) => entry.membershipId === 'membership_old')).toEqual([
      expect.objectContaining({ apiKeyId: 'api_old', revoked: true }),
      expect.objectContaining({ apiKeyId: 'api_membership_old', revoked: false })
    ]);
  });

  it('leave/remove revokes the key, removes member tokens, and ends membership atomically', async () => {
    const harness = createHarness({
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: {
          user_owner: 'shipit',
          user_member: 'member-user'
        },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null },
          { membershipId: 'membership_member', orgId: 'org_1', userId: 'user_member', endedAt: null }
        ],
        buyerKeys: [{
          apiKeyId: 'api_member',
          membershipId: 'membership_member',
          orgId: 'org_1',
          userId: 'user_member',
          plaintextKey: 'in_live_membership_member',
          revoked: false
        }]
      }
    });

    await expect(harness.service.leaveOrg({
      orgSlug: 'launch-team',
      actorUserId: 'user_member'
    })).resolves.toEqual({ membershipId: 'membership_member' });

    expect(harness.getState().buyerKeys).toEqual([
      expect.objectContaining({ membershipId: 'membership_member', revoked: true })
    ]);
    expect(harness.getState().removedTokens).toEqual([
      { orgId: 'org_1', userId: 'user_member' }
    ]);
    expect(harness.getState().memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: 'membership_member', endedAt: '2026-03-24T00:00:00.000Z' })
    ]));
  });

  it('rolls back leave/remove if buyer-key revocation or token cleanup fails mid-transaction', async () => {
    for (const failure of ['revoke', 'cleanup'] as const) {
      const harness = createHarness({
        state: {
          orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
          users: {
            user_owner: 'shipit',
            user_member: 'member-user'
          },
          memberships: [
            { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null },
            { membershipId: 'membership_member', orgId: 'org_1', userId: 'user_member', endedAt: null }
          ],
          buyerKeys: [{
            apiKeyId: 'api_member',
            membershipId: 'membership_member',
            orgId: 'org_1',
            userId: 'user_member',
            plaintextKey: 'in_live_membership_member',
            revoked: false
          }],
          failRevokeBuyerKey: failure === 'revoke',
          failRemoveTokens: failure === 'cleanup'
        }
      });

      await expect(harness.service.removeMember({
        orgSlug: 'launch-team',
        actorUserId: 'user_owner',
        memberUserId: 'user_member'
      })).rejects.toThrow();

      expect(harness.getState().buyerKeys).toEqual([
        expect.objectContaining({ membershipId: 'membership_member', revoked: false })
      ]);
      expect(harness.getState().removedTokens).toEqual([]);
      expect(harness.getState().memberships).toEqual(expect.arrayContaining([
        expect.objectContaining({ membershipId: 'membership_member', endedAt: null })
      ]));
    }
  });

  it('rejects owner self-leave and owner self-removal', async () => {
    const harness = createHarness({
      state: {
        orgs: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', ownerUserId: 'user_owner' }],
        users: { user_owner: 'shipit' },
        memberships: [
          { membershipId: 'membership_owner', orgId: 'org_1', userId: 'user_owner', endedAt: null }
        ]
      }
    });

    await expect(harness.service.leaveOrg({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner'
    })).rejects.toThrow('Owner cannot leave');

    await expect(harness.service.removeMember({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner',
      memberUserId: 'user_owner'
    })).rejects.toThrow('Owner cannot remove');
  });
});
