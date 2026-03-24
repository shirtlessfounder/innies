export type OrgSummary = {
  id: string;
  slug: string;
  name: string;
};

export type OrgAccessResponse =
  | { kind: 'not_found' }
  | {
      kind: 'sign_in_required';
      org: OrgSummary;
      authStartUrl: string;
    }
  | {
      kind: 'not_invited';
      org: OrgSummary;
    }
  | {
      kind: 'pending_invite';
      org: OrgSummary;
      invite: {
        inviteId: string;
        githubLogin: string;
      };
    }
  | {
      kind: 'active_membership';
      org: OrgSummary;
      membership: {
        membershipId: string;
        isOwner: boolean;
      };
    };

export type OrgMember = {
  userId: string;
  githubLogin: string | null;
  membershipId: string;
  isOwner: boolean;
};

export type OrgPendingInvite = {
  inviteId: string;
  githubLogin: string;
  createdAt: string;
};

export type OrgToken = {
  tokenId: string;
  provider: string;
  createdByUserId: string | null;
  createdByGithubLogin: string | null;
  fiveHourReservePercent: number;
  sevenDayReservePercent: number;
};

export type OrgTokensResponse = {
  tokens: OrgToken[];
};

export type OrgMembersResponse = {
  members: OrgMember[];
};

export type OrgInvitesResponse = {
  invites: OrgPendingInvite[];
};

export type OrgInvitePageState = {
  inviteId: string;
  githubLogin: string;
  org: OrgSummary;
};

export type OrgRevealPageState = {
  buyerKey: string;
  reason: 'org_created' | 'invite_accepted';
  org: OrgSummary;
};

export type OrgDashboardPageState = {
  org: OrgSummary;
  membership: {
    membershipId: string;
    isOwner: boolean;
    githubLogin: string;
  };
  analyticsPaths: {
    dashboardPath: string;
    timeseriesPath: string;
  };
  tokenPermissions: {
    canManageAllTokens: boolean;
  };
  tokens: OrgToken[];
  members: OrgMember[];
  pendingInvites: Array<{
    inviteId: string;
    githubLogin: string;
    createdAt: string;
  }>;
};

export type OrgPageState =
  | { kind: 'not_found' }
  | { kind: 'sign_in'; authStartUrl: string; org: OrgSummary }
  | { kind: 'not_invited'; org: OrgSummary }
  | { kind: 'invite'; invite: OrgInvitePageState }
  | { kind: 'reveal'; reveal: OrgRevealPageState }
  | { kind: 'dashboard'; data: OrgDashboardPageState };
