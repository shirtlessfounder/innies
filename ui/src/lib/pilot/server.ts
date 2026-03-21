import 'server-only';

import { headers } from 'next/headers';
import type {
  AdminPilotAccountView,
  ConnectedAccount,
  EarningsHistoryEntry,
  EarningsSummary,
  PilotFundingState,
  PilotDashboardData,
  PilotIdentityDiscoveryEntry,
  PilotSession,
  RequestHistoryRow,
  WalletLedgerEntry,
  WalletSnapshot,
  Withdrawal,
} from './types';

const DEFAULT_TIMEOUT_MS = 15_000;

type ApiConfig = {
  baseUrl: string;
  timeoutMs: number;
};

type AdminApiConfig = ApiConfig & {
  apiKey: string;
};

export class PilotServerError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'PilotServerError';
    this.status = status;
    this.details = details ?? null;
  }
}

function readBaseApiConfig(): ApiConfig {
  const baseUrl = process.env.INNIES_API_BASE_URL?.trim()
    || process.env.INNIES_BASE_URL?.trim();
  const timeoutMs = Number(process.env.INNIES_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  if (!baseUrl) {
    throw new PilotServerError(503, 'Missing INNIES_API_BASE_URL or INNIES_BASE_URL');
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS
  };
}

function readAdminApiConfig(): AdminApiConfig {
  const base = readBaseApiConfig();
  const apiKey = process.env.INNIES_ADMIN_API_KEY?.trim();
  if (!apiKey) {
    throw new PilotServerError(503, 'Missing INNIES_ADMIN_API_KEY');
  }
  return {
    ...base,
    apiKey
  };
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.code === 'string' && record.code.trim().length > 0) {
      return record.code;
    }
  }
  return fallback;
}

export async function readCurrentCookieHeader(): Promise<string | null> {
  const headerStore = await headers();
  return headerStore.get('cookie');
}

async function fetchJson<T>(input: {
  config: ApiConfig;
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  const url = new URL(input.path, `${input.config.baseUrl}/`);

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  try {
    const response = await fetch(url, {
      method: input.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.headers ?? {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    const body = text.length > 0 ? parseJsonBody(text) : null;

    if (!response.ok) {
      throw new PilotServerError(
        response.status,
        readErrorMessage(body, `Innies request failed (${response.status})`),
        body
      );
    }

    return body as T;
  } catch (error) {
    if (error instanceof PilotServerError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PilotServerError(504, `Timed out fetching ${input.path}`);
    }
    throw new PilotServerError(502, error instanceof Error ? error.message : `Failed to fetch ${input.path}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPilotJson<T>(input: {
  path: string;
  cookieHeader?: string | null;
  sessionToken?: string | null;
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
}): Promise<T> {
  const config = readBaseApiConfig();
  const cookieHeader = input.cookieHeader ?? await readCurrentCookieHeader();
  return fetchJson<T>({
    config,
    path: input.path,
    method: input.method,
    body: input.body,
    query: input.query,
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(input.sessionToken ? { authorization: `Bearer ${input.sessionToken}` } : {}),
      ...(input.headers ?? {})
    }
  });
}

export async function fetchAdminJson<T>(input: {
  path: string;
  query?: Record<string, string | undefined>;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const config = readAdminApiConfig();
  return fetchJson<T>({
    config,
    path: input.path,
    query: input.query,
    method: input.method,
    body: input.body,
    headers: {
      'x-api-key': config.apiKey
    }
  });
}

export function buildPilotAuthStartUrl(returnTo = '/pilot'): string {
  const config = readBaseApiConfig();
  const url = new URL('/v1/pilot/auth/github/start', `${config.baseUrl}/`);
  url.searchParams.set('returnTo', returnTo);
  return url.toString();
}

export async function getPilotSession(cookieHeader?: string | null): Promise<PilotSession | null> {
  try {
    const response = await fetchPilotJson<{ ok: true; session: PilotSession }>({
      path: '/v1/pilot/session',
      cookieHeader
    });
    return response.session;
  } catch (error) {
    if (error instanceof PilotServerError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function getPilotConnectedAccounts(cookieHeader?: string | null): Promise<ConnectedAccount[]> {
  const response = await fetchPilotJson<{ ok: true; accounts: ConnectedAccount[] }>({
    path: '/v1/pilot/connected-accounts',
    cookieHeader
  });
  return response.accounts;
}

export async function createAdminPilotSession(identity: PilotIdentityDiscoveryEntry): Promise<string> {
  const response = await fetchAdminJson<{ ok: true; sessionToken: string }>({
    path: '/v1/admin/pilot/session',
    method: 'POST',
    body: {
      mode: 'impersonation',
      targetUserId: identity.targetUserId,
      targetOrgId: identity.targetOrgId,
      targetOrgSlug: identity.targetOrgSlug ?? undefined,
      targetOrgName: identity.targetOrgName ?? undefined,
      githubLogin: identity.githubLogin ?? undefined,
      userEmail: identity.userEmail
    }
  });
  return response.sessionToken;
}

export async function listAdminPilotIdentities(): Promise<PilotIdentityDiscoveryEntry[]> {
  const response = await fetchAdminJson<{ ok: true; identities: PilotIdentityDiscoveryEntry[] }>({
    path: '/v1/admin/pilot/identities'
  });
  return response.identities;
}

export async function getPilotDashboardData(cookieHeader?: string | null): Promise<PilotDashboardData | null> {
  const session = await getPilotSession(cookieHeader);
  if (!session) return null;

  const [wallet, walletLedger, funding, accounts, earningsSummary, earningsHistory, withdrawals, requests] = await Promise.all([
    fetchPilotJson<{ ok: true; wallet: WalletSnapshot }>({
      path: '/v1/pilot/wallet',
      cookieHeader
    }).then((response) => response.wallet),
    fetchPilotJson<{ ok: true; ledger: WalletLedgerEntry[] }>({
      path: '/v1/pilot/wallet/ledger',
      cookieHeader,
      query: { limit: '50' }
    }).then((response) => response.ledger),
    fetchPilotJson<{ ok: true; funding: PilotFundingState }>({
      path: '/v1/pilot/payments',
      cookieHeader
    }).then((response) => response.funding),
    getPilotConnectedAccounts(cookieHeader),
    fetchPilotJson<{ ok: true; summary: EarningsSummary }>({
      path: '/v1/pilot/earnings/summary',
      cookieHeader
    }).then((response) => response.summary),
    fetchPilotJson<{ ok: true; entries: EarningsHistoryEntry[] }>({
      path: '/v1/pilot/earnings/history',
      cookieHeader
    }).then((response) => response.entries),
    fetchPilotJson<{ ok: true; withdrawals: Withdrawal[] }>({
      path: '/v1/pilot/withdrawals',
      cookieHeader
    }).then((response) => response.withdrawals),
    fetchPilotJson<{ requests: RequestHistoryRow[] }>({
      path: '/v1/pilot/requests',
      cookieHeader,
      query: {
        limit: '50'
      }
    }).then((response) => response.requests)
  ]);

  return {
    session,
    wallet,
    walletLedger,
    funding,
    requests,
    accounts,
    earningsSummary,
    earningsHistory,
    withdrawals
  };
}

export async function getAdminPilotAccountView(input: {
  orgId: string;
  explainRequestId?: string | null;
}): Promise<AdminPilotAccountView | null> {
  const identities = await listAdminPilotIdentities();
  const identity = identities.find((entry) => entry.targetOrgId === input.orgId) ?? null;
  if (!identity) return null;

  const sessionToken = await createAdminPilotSession(identity);

  const [wallet, walletLedger, requests, accounts, earningsSummary, earningsHistory, withdrawals, requestExplanation] = await Promise.all([
    fetchAdminJson<{ ok: true; wallet: WalletSnapshot }>({
      path: `/v1/admin/wallets/${identity.targetOrgId}`
    }).then((response) => response.wallet),
    fetchAdminJson<{ ok: true; ledger: WalletLedgerEntry[] }>({
      path: `/v1/admin/wallets/${identity.targetOrgId}/ledger`,
      query: { limit: '50' }
    }).then((response) => response.ledger),
    fetchAdminJson<{ requests: RequestHistoryRow[] }>({
      path: '/v1/admin/requests',
      query: {
        consumerOrgId: identity.targetOrgId,
        historyScope: 'post_cutover',
        limit: '50'
      }
    }).then((response) => response.requests),
    fetchAdminJson<{ ok: true; accounts: ConnectedAccount[] }>({
      path: '/v1/admin/pilot/connected-accounts',
      query: { ownerOrgId: identity.targetOrgId }
    }).then((response) => response.accounts),
    fetchPilotJson<{ ok: true; summary: EarningsSummary }>({
      path: '/v1/pilot/earnings/summary',
      sessionToken
    }).then((response) => response.summary).catch((error) => {
      if (error instanceof PilotServerError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        return null;
      }
      throw error;
    }),
    fetchPilotJson<{ ok: true; entries: EarningsHistoryEntry[] }>({
      path: '/v1/pilot/earnings/history',
      sessionToken
    }).then((response) => response.entries).catch((error) => {
      if (error instanceof PilotServerError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        return [];
      }
      throw error;
    }),
    fetchAdminJson<{ withdrawals: Withdrawal[] }>({
      path: '/v1/admin/pilot/withdrawals',
      query: { ownerOrgId: identity.targetOrgId }
    }).then((response) => response.withdrawals),
    input.explainRequestId
      ? fetchAdminJson<{ ok: true; request: RequestHistoryRow }>({
        path: `/v1/admin/requests/${input.explainRequestId}/explanation`
      }).then((response) => response.request)
      : Promise.resolve(null)
  ]);

  return {
    identity,
    wallet,
    walletLedger,
    requests,
    requestExplanation,
    accounts,
    earningsSummary,
    earningsHistory,
    withdrawals
  };
}
