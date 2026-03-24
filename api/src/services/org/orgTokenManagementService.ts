import type { TokenCredential, TokenCredentialRepository } from '../../repos/tokenCredentialRepository.js';
import type { TokenCredentialService } from '../tokenCredentialService.js';
import { attemptTokenCredentialRefresh } from '../tokenCredentialOauthRefresh.js';
import { AppError } from '../../utils/errors.js';
import { isOpenAiOauthAccessToken, resolveOpenAiOauthExpiresAt } from '../../utils/openaiOauth.js';
import type { OrgAccessRepository } from '../../repos/orgAccessRepository.js';
import type { OrgTokenRepository } from '../../repos/orgTokenRepository.js';

type OrgAccessRepositoryLike = Pick<OrgAccessRepository, 'findOrgBySlug' | 'listMembers'>;
type OrgTokenRepositoryLike = Pick<OrgTokenRepository, 'listOrgTokens'>;
type TokenCredentialRepositoryLike = Pick<TokenCredentialRepository, 'getById'>;
type TokenCredentialServiceLike = Pick<
  TokenCredentialService,
  'create' | 'updateContributionCap' | 'revoke'
>;

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'codex' ? 'openai' : normalized;
}

function isAnthropicOauthAccessToken(provider: string, accessToken: string): boolean {
  return provider === 'anthropic' && accessToken.includes('sk-ant-oat');
}

function resolveTokenCredentialAuthScheme(provider: string, accessToken: string): 'x_api_key' | 'bearer' {
  if (isAnthropicOauthAccessToken(provider, accessToken)) {
    return 'bearer';
  }
  if ((provider === 'openai' || provider === 'codex') && isOpenAiOauthAccessToken(accessToken)) {
    return 'bearer';
  }
  return 'x_api_key';
}

function resolveTokenCredentialExpiresAt(provider: string, accessToken: string): Date {
  if ((provider === 'openai' || provider === 'codex') && isOpenAiOauthAccessToken(accessToken)) {
    return resolveOpenAiOauthExpiresAt(accessToken) ?? new Date('9999-12-31T23:59:59.999Z');
  }
  return new Date('9999-12-31T23:59:59.999Z');
}

export class OrgTokenManagementService {
  private readonly refreshTokenCredential: (
    credential: TokenCredential
  ) => Promise<TokenCredential | null>;

  constructor(private readonly input: {
    orgAccessRepository: OrgAccessRepositoryLike;
    orgTokenRepository: OrgTokenRepositoryLike;
    tokenCredentialRepository: TokenCredentialRepositoryLike;
    tokenCredentialService: TokenCredentialServiceLike;
    refreshTokenCredential?: (
      credential: TokenCredential
    ) => Promise<TokenCredential | null>;
  }) {
    this.refreshTokenCredential = input.refreshTokenCredential
      ?? ((credential) => attemptTokenCredentialRefresh(
        input.tokenCredentialRepository as TokenCredentialRepository,
        credential
      ));
  }

  async addOrgToken(input: {
    orgSlug: string;
    actorUserId: string;
    token: string;
    provider: string;
    fiveHourReservePercent?: number;
    sevenDayReservePercent?: number;
  }): Promise<{ tokenId: string }> {
    const { org, actorMembership } = await this.resolveActorMembership(input.orgSlug, input.actorUserId);
    const provider = normalizeProvider(input.provider);
    const fiveHourReservePercent = this.normalizeReservePercent(
      input.fiveHourReservePercent,
      'fiveHourReservePercent'
    );
    const sevenDayReservePercent = this.normalizeReservePercent(
      input.sevenDayReservePercent,
      'sevenDayReservePercent'
    );

    const created = await this.input.tokenCredentialService.create({
      orgId: org.id,
      provider,
      authScheme: resolveTokenCredentialAuthScheme(provider, input.token),
      accessToken: input.token,
      refreshToken: null,
      expiresAt: resolveTokenCredentialExpiresAt(provider, input.token),
      createdBy: actorMembership.userId
    }, {
      actorUserId: actorMembership.userId
    });

    await this.input.tokenCredentialService.updateContributionCap(created.id, {
      fiveHourReservePercent,
      sevenDayReservePercent
    }, {
      actorUserId: actorMembership.userId
    });

    return { tokenId: created.id };
  }

  async refreshOrgToken(input: {
    orgSlug: string;
    actorUserId: string;
    tokenId: string;
  }): Promise<void> {
    const { org } = await this.resolveAuthorizedTokenMutation(input.orgSlug, input.actorUserId, input.tokenId);
    const credential = await this.input.tokenCredentialRepository.getById(input.tokenId);

    if (!credential || credential.orgId !== org.id) {
      throw new AppError('not_found', 404, `Token not found: ${input.tokenId}`);
    }

    const refreshed = await this.refreshTokenCredential(credential);
    if (!refreshed) {
      throw new AppError('upstream_error', 502, 'Token refresh failed');
    }
  }

  async removeOrgToken(input: {
    orgSlug: string;
    actorUserId: string;
    tokenId: string;
  }): Promise<void> {
    const { org } = await this.resolveAuthorizedTokenMutation(input.orgSlug, input.actorUserId, input.tokenId);
    const revoked = await this.input.tokenCredentialService.revoke(input.tokenId, org.id, {
      actorUserId: input.actorUserId
    });

    if (!revoked) {
      throw new AppError('not_found', 404, `Token not found: ${input.tokenId}`);
    }
  }

  private async resolveActorMembership(orgSlug: string, actorUserId: string): Promise<{
    org: { id: string; slug: string; name: string; ownerUserId: string };
    actorMembership: { userId: string; githubLogin: string | null; membershipId: string; isOwner: boolean };
  }> {
    const org = await this.input.orgAccessRepository.findOrgBySlug(orgSlug);
    if (!org) {
      throw new AppError('not_found', 404, `Org not found: ${orgSlug}`);
    }

    const actorMembership = (await this.input.orgAccessRepository.listMembers(org.id))
      .find((entry) => entry.userId === actorUserId);

    if (!actorMembership) {
      throw new AppError('forbidden', 403, 'Actor is not allowed to manage tokens for this org');
    }

    return { org, actorMembership };
  }

  private async resolveAuthorizedTokenMutation(
    orgSlug: string,
    actorUserId: string,
    tokenId: string
  ): Promise<{
    org: { id: string; slug: string; name: string; ownerUserId: string };
    actorMembership: { userId: string; githubLogin: string | null; membershipId: string; isOwner: boolean };
    token: {
      tokenId: string;
      provider: string;
      createdByUserId: string;
      createdByGithubLogin: string | null;
      fiveHourReservePercent: number;
      sevenDayReservePercent: number;
    };
  }> {
    const { org, actorMembership } = await this.resolveActorMembership(orgSlug, actorUserId);
    const token = (await this.input.orgTokenRepository.listOrgTokens(org.id))
      .find((entry) => entry.tokenId === tokenId);

    if (!token) {
      throw new AppError('not_found', 404, `Token not found: ${tokenId}`);
    }

    if (!actorMembership.isOwner && token.createdByUserId !== actorUserId) {
      throw new AppError('forbidden', 403, 'Actor is not allowed to manage this token');
    }

    return { org, actorMembership, token };
  }

  private normalizeReservePercent(
    value: number | undefined,
    field: 'fiveHourReservePercent' | 'sevenDayReservePercent'
  ): number {
    if (value === undefined) {
      return 0;
    }
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new AppError('invalid_request', 400, `${field} must be within 0..100`);
    }
    return value;
  }
}
