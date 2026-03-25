import { describe, expect, it, vi } from 'vitest';
import { OrgTokenManagementService } from '../src/services/org/orgTokenManagementService.js';
import { AppError } from '../src/utils/errors.js';

type TokenInventoryRow = {
  tokenId: string;
  provider: string;
  createdByUserId: string;
  createdByGithubLogin: string | null;
  fiveHourReservePercent: number;
  sevenDayReservePercent: number;
};

function createHarness() {
  const orgs = [{
    id: 'org_1',
    slug: 'launch-team',
    name: 'Launch Team',
    ownerUserId: 'user_owner'
  }];
  const members = [
    {
      userId: 'user_owner',
      githubLogin: 'shipit',
      membershipId: 'membership_owner',
      isOwner: true
    },
    {
      userId: 'user_member',
      githubLogin: 'member-user',
      membershipId: 'membership_member',
      isOwner: false
    },
    {
      userId: 'user_other',
      githubLogin: 'other-member',
      membershipId: 'membership_other',
      isOwner: false
    }
  ];
  const inventory: TokenInventoryRow[] = [{
    tokenId: 'token_member',
    provider: 'openai',
    createdByUserId: 'user_member',
    createdByGithubLogin: 'member-user',
    fiveHourReservePercent: 15,
    sevenDayReservePercent: 35
  }];
  const credentials = new Map<string, any>([
    ['token_member', {
      id: 'token_member',
      orgId: 'org_1',
      provider: 'openai',
      authScheme: 'x_api_key',
      accessToken: 'sk-live-member',
      refreshToken: 'rt-live-member',
      expiresAt: new Date('2036-03-24T00:00:00.000Z'),
      status: 'active',
      rotationVersion: 1,
      createdAt: new Date('2026-03-20T00:00:00.000Z'),
      updatedAt: new Date('2026-03-20T00:00:00.000Z'),
      revokedAt: null,
      monthlyContributionLimitUnits: null,
      monthlyContributionUsedUnits: 0,
      monthlyWindowStartAt: new Date('2026-03-01T00:00:00.000Z'),
      fiveHourReservePercent: 15,
      sevenDayReservePercent: 35,
      debugLabel: null,
      consecutiveFailureCount: 0,
      consecutiveRateLimitCount: 0,
      lastFailedStatus: null,
      lastFailedAt: null,
      lastRateLimitedAt: null,
      maxedAt: null,
      rateLimitedUntil: null,
      nextProbeAt: null,
      lastProbeAt: null
    }]
  ]);
  const createdInputs: any[] = [];
  const validatedInputs: any[] = [];
  const updatedCaps: Array<{ id: string; input: { fiveHourReservePercent?: number; sevenDayReservePercent?: number } }> = [];
  const revokedIds: string[] = [];
  const probeTokenCredential = vi.fn(async (credential: any) => ({
    ok: true,
    statusCode: 200,
    reason: 'ok',
    reactivated: false,
    status: credential.status === 'maxed' ? 'maxed' : 'active',
    nextProbeAt: null,
    authValid: true,
    availabilityOk: true,
    usageExhausted: false,
    usageExhaustedWindow: null,
    usageResetAt: null,
    refreshAttempted: false,
    refreshSucceeded: null,
    refreshReason: null,
    refreshedCredential: false
  }));

  const tokenCredentialService = {
    create: vi.fn(async (input: any) => {
      createdInputs.push(input);
      const id = 'token_created';
      credentials.set(id, {
        id,
        orgId: input.orgId,
        provider: input.provider,
        authScheme: input.authScheme,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        expiresAt: input.expiresAt,
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-24T00:00:00.000Z'),
        updatedAt: new Date('2026-03-24T00:00:00.000Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00.000Z'),
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0,
        debugLabel: null,
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      });
      inventory.push({
        tokenId: id,
        provider: input.provider,
        createdByUserId: input.createdBy,
        createdByGithubLogin: members.find((entry) => entry.userId === input.createdBy)?.githubLogin ?? null,
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0
      });
      return { id, rotationVersion: 1 };
    }),
    updateContributionCap: vi.fn(async (id: string, input: { fiveHourReservePercent?: number; sevenDayReservePercent?: number }) => {
      updatedCaps.push({ id, input });
      const row = inventory.find((entry) => entry.tokenId === id);
      if (row) {
        row.fiveHourReservePercent = input.fiveHourReservePercent ?? row.fiveHourReservePercent;
        row.sevenDayReservePercent = input.sevenDayReservePercent ?? row.sevenDayReservePercent;
      }
      const credential = credentials.get(id);
      if (credential) {
        credential.fiveHourReservePercent = row?.fiveHourReservePercent ?? credential.fiveHourReservePercent;
        credential.sevenDayReservePercent = row?.sevenDayReservePercent ?? credential.sevenDayReservePercent;
      }
      return row ? {
        id: row.tokenId,
        orgId: 'org_1',
        provider: row.provider,
        fiveHourReservePercent: row.fiveHourReservePercent,
        sevenDayReservePercent: row.sevenDayReservePercent,
      } : null;
    }),
    revoke: vi.fn(async (id: string) => {
      revokedIds.push(id);
      return true;
    })
  };

  const refreshTokenCredential = vi.fn(async (credential: any) => {
    const refreshed = {
      ...credential,
      accessToken: 'sk-live-refreshed',
      updatedAt: new Date('2026-03-24T00:00:00.000Z')
    };
    credentials.set(credential.id, refreshed);
    return refreshed;
  });

  const validateTokenMaterial = vi.fn(async (input: {
    provider: string;
    accessToken: string;
    refreshToken: string;
  }) => {
    validatedInputs.push(input);
    return {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: new Date('2036-03-24T00:00:00.000Z')
    };
  });

  const service = new OrgTokenManagementService({
    orgAccessRepository: {
      findOrgBySlug: vi.fn(async (slug: string) => orgs.find((entry) => entry.slug === slug) ?? null),
      listMembers: vi.fn(async (_orgId: string) => members)
    } as any,
    orgTokenRepository: {
      listOrgTokens: vi.fn(async (_orgId: string) => inventory)
    } as any,
    tokenCredentialRepository: {
      getById: vi.fn(async (id: string) => credentials.get(id) ?? null)
    } as any,
    tokenCredentialService: tokenCredentialService as any,
    refreshTokenCredential,
    validateTokenMaterial,
    probeTokenCredential
  });

  return {
    service,
    inventory,
    createdInputs,
    validatedInputs,
    updatedCaps,
    revokedIds,
    refreshTokenCredential,
    validateTokenMaterial,
    probeTokenCredential
  };
}

describe('OrgTokenManagementService', () => {
  it('rejects construction when token credential service wiring is missing', () => {
    expect(() => new OrgTokenManagementService({
      orgAccessRepository: {
        findOrgBySlug: vi.fn(),
        listMembers: vi.fn()
      } as any,
      orgTokenRepository: {
        listOrgTokens: vi.fn()
      } as any,
      tokenCredentialRepository: {
        getById: vi.fn()
      } as any,
      tokenCredentialService: undefined as any
    })).toThrow('OrgTokenManagementService requires tokenCredentialService');
  });

  it('accepts optional reserve values and persists them onto the token credential', async () => {
    const harness = createHarness();

    await expect(harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created',
      fiveHourReservePercent: 25,
      sevenDayReservePercent: 40
    })).resolves.toEqual({ tokenId: 'token_created' });

    expect(harness.createdInputs[0]).toEqual(expect.objectContaining({
      orgId: 'org_1',
      provider: 'openai',
      accessToken: 'sk-live-created',
      createdBy: 'user_member'
    }));
    expect(harness.updatedCaps).toEqual([{
      id: 'token_created',
      input: {
        fiveHourReservePercent: 25,
        sevenDayReservePercent: 40
      }
    }]);
    expect(harness.inventory.find((entry) => entry.tokenId === 'token_created')).toEqual(expect.objectContaining({
      fiveHourReservePercent: 25,
      sevenDayReservePercent: 40
    }));
  });

  it('persists an optional debug label onto the created token credential', async () => {
    const harness = createHarness();

    await expect(harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      debugLabel: 'testing-test-codex-main',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created'
    })).resolves.toEqual({ tokenId: 'token_created' });

    expect(harness.createdInputs[0]).toEqual(expect.objectContaining({
      debugLabel: 'testing-test-codex-main'
    }));
  });

  it('persists the refresh token onto the created token credential', async () => {
    const harness = createHarness();

    await expect(harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created'
    } as any)).resolves.toEqual({ tokenId: 'token_created' });

    expect(harness.createdInputs[0]).toEqual(expect.objectContaining({
      refreshToken: 'rt-live-created',
      authScheme: 'bearer',
      expiresAt: new Date('2036-03-24T00:00:00.000Z')
    }));
    expect(harness.validatedInputs[0]).toEqual({
      provider: 'openai',
      accessToken: 'sk-live-created',
      refreshToken: 'rt-live-created'
    });
  });

  it('rejects add when token preflight validation fails', async () => {
    const harness = createHarness();
    harness.validateTokenMaterial.mockRejectedValueOnce(
      new AppError('invalid_request', 400, 'Codex/OpenAI OAuth token is not valid.')
    );

    await expect(harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created'
    })).rejects.toThrow('not valid');

    expect(harness.createdInputs).toHaveLength(0);
  });

  it('defaults omitted reserve inputs to 0', async () => {
    const harness = createHarness();

    await harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created'
    });

    expect(harness.updatedCaps).toEqual([{
      id: 'token_created',
      input: {
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0
      }
    }]);
    expect(harness.inventory.find((entry) => entry.tokenId === 'token_created')).toEqual(expect.objectContaining({
      fiveHourReservePercent: 0,
      sevenDayReservePercent: 0
    }));
  });

  it('rejects reserve values outside 0..100', async () => {
    const harness = createHarness();

    await expect(harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created',
      fiveHourReservePercent: -1
    })).rejects.toThrow('0..100');

    await expect(harness.service.addOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created',
      sevenDayReservePercent: 101
    })).rejects.toThrow('0..100');
  });

  it('lets the owner update reserve floors on any org token', async () => {
    const harness = createHarness();

    await expect(harness.service.updateOrgTokenReserve({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner',
      tokenId: 'token_member',
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48,
    })).resolves.toEqual({
      tokenId: 'token_member',
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48,
    });

    expect(harness.updatedCaps).toContainEqual({
      id: 'token_member',
      input: {
        fiveHourReservePercent: 22,
        sevenDayReservePercent: 48,
      },
    });
    expect(harness.inventory.find((entry) => entry.tokenId === 'token_member')).toEqual(expect.objectContaining({
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48,
    }));
  });

  it('lets the owner trigger a manual probe for any org token', async () => {
    const harness = createHarness();

    await expect(harness.service.probeOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner',
      tokenId: 'token_member',
    })).resolves.toEqual(expect.objectContaining({
      tokenId: 'token_member',
      probeOk: expect.any(Boolean),
    }));
  });

  it('rejects reserve floor updates from non-owners', async () => {
    const harness = createHarness();

    await expect(harness.service.updateOrgTokenReserve({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      tokenId: 'token_member',
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48,
    })).rejects.toThrow('Owner access required');

    expect(harness.updatedCaps).toEqual([]);
  });

  it('rejects manual probe from non-owners', async () => {
    const harness = createHarness();

    await expect(harness.service.probeOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      tokenId: 'token_member',
    })).rejects.toThrow('Owner access required');
  });

  it('allows the owner to mutate any token and blocks members from mutating another member token', async () => {
    const harness = createHarness();

    await expect(harness.service.removeOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner',
      tokenId: 'token_member'
    })).resolves.toBeUndefined();

    expect(harness.revokedIds).toEqual(['token_member']);

    await expect(harness.service.removeOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_other',
      tokenId: 'token_member'
    })).rejects.toThrow('not allowed');
  });

  it('preserves original token ownership when the owner refreshes another member token', async () => {
    const harness = createHarness();

    await expect(harness.service.refreshOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_owner',
      tokenId: 'token_member'
    })).resolves.toBeUndefined();

    expect(harness.refreshTokenCredential).toHaveBeenCalledTimes(1);
    expect(harness.inventory.find((entry) => entry.tokenId === 'token_member')).toEqual(expect.objectContaining({
      createdByUserId: 'user_member',
      fiveHourReservePercent: 15,
      sevenDayReservePercent: 35
    }));
  });

  it('preserves the existing reserve values on refresh', async () => {
    const harness = createHarness();

    await harness.service.refreshOrgToken({
      orgSlug: 'launch-team',
      actorUserId: 'user_member',
      tokenId: 'token_member'
    });

    expect(harness.inventory.find((entry) => entry.tokenId === 'token_member')).toEqual(expect.objectContaining({
      fiveHourReservePercent: 15,
      sevenDayReservePercent: 35
    }));
  });
});
