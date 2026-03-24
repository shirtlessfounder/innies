import 'server-only';

import { cookies } from 'next/headers';
import { fetchPilotJson, PilotServerError } from '../pilot/server';
import {
  ORG_SESSION_COOKIE_NAME,
  readOrgRevealCookie,
} from './sessionCookie';
import type {
  OrgAccessResponse,
  OrgDashboardPageState,
  OrgInvitesResponse,
  OrgMembersResponse,
  OrgPageState,
  OrgTokensResponse,
} from './types';

function normalizeOrgSlug(orgSlug: string): string {
  return orgSlug.trim().toLowerCase();
}

function readApiBaseUrl(): string {
  const baseUrl = process.env.INNIES_API_BASE_URL?.trim()
    || process.env.INNIES_BASE_URL?.trim();
  if (!baseUrl) {
    throw new PilotServerError(503, 'Missing INNIES_API_BASE_URL or INNIES_BASE_URL');
  }
  return baseUrl.replace(/\/+$/, '');
}

function readErrorCode(error: unknown): string | null {
  if (!(error instanceof PilotServerError) || !error.details || typeof error.details !== 'object') {
    return null;
  }
  const record = error.details as Record<string, unknown>;
  if (typeof record.code === 'string' && record.code.trim().length > 0) {
    return record.code;
  }
  if (typeof record.kind === 'string' && record.kind.trim().length > 0) {
    return record.kind;
  }
  return null;
}

export function buildOrgAuthStartUrl(returnTo = '/'): string {
  const url = new URL('/v1/org/auth/github/start', `${readApiBaseUrl()}/`);
  url.searchParams.set('returnTo', returnTo);
  return url.toString();
}

export async function getOrgLandingState(): Promise<{
  signedIn: boolean;
  authStartUrl: string;
}> {
  const cookieStore = await cookies();
  return {
    signedIn: cookieStore.has(ORG_SESSION_COOKIE_NAME),
    authStartUrl: buildOrgAuthStartUrl('/'),
  };
}

async function fetchOrgAccess(orgSlug: string): Promise<OrgAccessResponse> {
  try {
    return await fetchPilotJson<OrgAccessResponse>({
      path: `/v1/orgs/${orgSlug}/access`,
    });
  } catch (error) {
    if (error instanceof PilotServerError && error.status === 404) {
      return { kind: 'not_found' };
    }
    throw error;
  }
}

async function fetchDashboardState(input: {
  orgSlug: string;
  orgId: string;
  orgName: string;
  membershipId: string;
  isOwner: boolean;
}): Promise<OrgDashboardPageState> {
  const { isOwner, membershipId, orgId, orgName, orgSlug } = input;
  const [tokensResponse, membersResponse, invitesResponse] = await Promise.all([
    fetchPilotJson<OrgTokensResponse>({
      path: `/v1/orgs/${orgSlug}/tokens`,
    }),
    fetchPilotJson<OrgMembersResponse>({
      path: `/v1/orgs/${orgSlug}/members`,
    }),
    isOwner
      ? fetchPilotJson<OrgInvitesResponse>({
          path: `/v1/orgs/${orgSlug}/invites`,
        })
      : Promise.resolve({ invites: [] }),
  ]);

  const currentMember = membersResponse.members.find((member) => member.membershipId === membershipId);

  if (!isOwner) {
    return {
      org: {
        id: orgId,
        slug: orgSlug,
        name: orgName,
      },
      membership: {
        membershipId,
        isOwner,
        githubLogin: currentMember?.githubLogin ?? '',
      },
      analyticsPaths: {
        dashboardPath: `/api/orgs/${orgSlug}/analytics/dashboard`,
        timeseriesPath: `/api/orgs/${orgSlug}/analytics/timeseries`,
      },
      tokenPermissions: {
        canManageAllTokens: isOwner,
      },
      tokens: tokensResponse.tokens,
      members: membersResponse.members,
      pendingInvites: [],
    };
  }

  return {
    org: {
      id: orgId,
      slug: orgSlug,
      name: orgName,
    },
    membership: {
      membershipId,
      isOwner,
      githubLogin: currentMember?.githubLogin ?? '',
    },
    analyticsPaths: {
      dashboardPath: `/api/orgs/${orgSlug}/analytics/dashboard`,
      timeseriesPath: `/api/orgs/${orgSlug}/analytics/timeseries`,
    },
    tokenPermissions: {
      canManageAllTokens: isOwner,
    },
    tokens: tokensResponse.tokens,
    members: membersResponse.members,
    pendingInvites: invitesResponse.invites,
  };
}

export async function getOrgPageState(orgSlug: string): Promise<OrgPageState> {
  const normalizedOrgSlug = normalizeOrgSlug(orgSlug);
  const access = await fetchOrgAccess(normalizedOrgSlug);

  switch (access.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'sign_in_required':
      return {
        kind: 'sign_in',
        authStartUrl: access.authStartUrl,
        org: access.org,
      };
    case 'not_invited':
      return {
        kind: 'not_invited',
        org: access.org,
      };
    case 'pending_invite':
      return {
        kind: 'invite',
        invite: {
          inviteId: access.invite.inviteId,
          githubLogin: access.invite.githubLogin,
          org: access.org,
        },
      };
    case 'active_membership': {
      const reveal = await readOrgRevealCookie(normalizedOrgSlug);
      if (reveal) {
        return {
          kind: 'reveal',
          reveal: {
            buyerKey: reveal.buyerKey,
            reason: reveal.reason,
            org: access.org,
          },
        };
      }

      const data = await fetchDashboardState({
        orgSlug: normalizedOrgSlug,
        orgId: access.org.id,
        orgName: access.org.name,
        membershipId: access.membership.membershipId,
        isOwner: access.membership.isOwner,
      });
      return {
        kind: 'dashboard',
        data,
      };
    }
    default:
      throw new PilotServerError(500, `Unhandled org access state: ${(access as { kind?: string }).kind ?? 'unknown'}`);
  }
}

export function isInviteNoLongerValidError(error: unknown): boolean {
  return readErrorCode(error) === 'invite_no_longer_valid';
}
