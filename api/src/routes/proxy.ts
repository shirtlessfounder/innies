import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { TokenCredential } from '../repos/tokenCredentialRepository.js';
import type { TokenCredentialProviderUsageSnapshot } from '../repos/tokenCredentialProviderUsageRepository.js';
import { runtime } from '../services/runtime.js';
import type { ArchiveAttemptInput, ArchivePayloadFormat, ArchivePayloadSource } from '../services/archive/archiveTypes.js';
import type { IdempotencySession } from '../services/idempotencyService.js';
import { AppError } from '../utils/errors.js';
import { sha256Hex, stableJson } from '../utils/hash.js';
import { readAndValidateIdempotencyKey } from '../utils/idempotencyKey.js';
import { anthropicToOpenAi } from '../utils/anthropicToOpenai.js';
import { mapOpenAiErrorToAnthropic, translateOpenAiToAnthropic } from '../utils/openaiToAnthropic.js';
import { OpenAiToAnthropicStreamTransform } from '../utils/openaiToAnthropicStream.js';
import {
  buildSyntheticOpenAiResponsesSse,
  buildSyntheticOpenAiStreamFailureSse,
  extractTerminalOpenAiResponseFromSse,
  hasTerminalOpenAiResponsesStreamEvent,
  summarizeSyntheticOpenAiOutputItems
} from '../utils/openaiSyntheticStream.js';
import {
  collectTraceResponseHeaders,
  persistCompatTraceBody,
  sanitizeTraceHeaders
} from '../utils/compatTrace.js';
import { extractRequestPreview, extractResponsePreview } from '../utils/requestLogPreview.js';
import {
  isOpenAiOauthAccessToken,
  resolveOpenAiOauthAccountId
} from '../utils/openaiOauth.js';
import {
  CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON,
  anthropicOauthUsageAuthFailureStatusCode,
  evaluateClaudeContributionCap,
  isAnthropicOauthTokenCredential,
  isOpenAiProviderUsageRefreshCredential,
  parkAnthropicOauthCredentialAfterUsageAuthFailure,
  providerUsageWarningReasonFromRefreshOutcome,
  readTokenCredentialProviderUsageSoftStaleMs,
  readTokenCredentialProviderUsageHardStaleMs,
  readTokenCredentialRateLimitLongBackoffMinutes
} from '../services/tokenCredentialProviderUsage.js';
import {
  readClaudeContributionCapSnapshotState,
  readClaudeProviderUsageExhaustionHoldState
} from '../services/claudeContributionCapState.js';
import {
  attemptTokenCredentialRefresh,
  refreshAnthropicOauthUsageWithCredentialRefresh
} from '../services/tokenCredentialOauthRefresh.js';
import {
  armNextPromptProviderOverride,
  consumeNextPromptProviderOverride
} from '../services/nextPromptProviderOverride.js';

const router = Router();

const proxyRequestSchema = z.object({
  provider: z.string().min(1).default('anthropic'),
  model: z.string().min(1).default('claude-code'),
  streaming: z.boolean().default(true),
  payload: z.unknown().optional(),
});

const nativeAnthropicProxyRequestSchema = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional()
}).passthrough();

const nativeOpenAiResponsesRequestSchema = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional()
}).passthrough();

type AttemptFailure = {
  statusCode?: number;
  message?: string;
  kind?: string;
};

type ProxyRouteResult = {
  requestId: string;
  keyId: string | null;
  attemptNo: number;
  upstreamStatus: number;
  usageUnits: number;
  contentType: string;
  data: unknown;
  routeKind: 'seller_key' | 'token_credential';
  alreadyRecorded: boolean;
  routeDecision?: Record<string, unknown>;
  ttfbMs?: number | null;
};

type MeteringSource = 'payload_usage' | 'stream_usage' | 'stream_estimate';
type RequestSource = 'openclaw' | 'cli-claude' | 'cli-codex' | 'direct';
type OpenClawCorrelation = {
  openclawRunId: string;
  openclawSessionId?: string;
  sourceExplicit: boolean;
};
type RetryReason =
  | 'blocked_403_compat_retry'
  | 'oauth_401_compat_retry'
  | 'credential_refresh_retry'
  | 'rate_limited_backoff';

type ProviderSelectionReason =
  | 'preferred_provider_selected'
  | 'fallback_provider_selected'
  | 'cli_provider_pinned';

type ProviderPreferenceMeta = {
  preferredProvider: string;
  effectiveProvider: string;
  fallbackFromProvider?: string;
  fallbackReason?: string;
  providerPlan: string[];
  selectionReason: ProviderSelectionReason;
};

type CompatTranslationMeta = {
  translated: true;
  originalProvider: string;
  originalModel: string;
  originalPath: string;
  translatedPath: string;
  translatedModel: string;
  strategy: 'anthropic_messages_to_openai_responses';
};

type RescueScope = 'same_provider' | 'cross_provider';

type RescueFailureSnapshot = {
  provider: string;
  credentialId: string;
  credentialLabel?: string | null;
  attemptNo: number;
  failureCode: string;
  failureStatus: number | null;
};

type RescueTracker = {
  firstFailure: RescueFailureSnapshot | null;
};

type ProxyArchiveHookInput = {
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId: string;
  routeKind: 'seller_key' | 'token_credential';
  sellerKeyId?: string | null;
  tokenCredentialId?: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  upstreamStatus?: number | null;
  errorCode?: string | null;
  requestPath: string;
  requestPayload: unknown;
  responsePayload?: unknown;
  rawRequest?: unknown;
  rawResponse?: unknown;
  rawStream?: unknown;
  startedAtMs: number;
  completedAtMs?: number;
  correlation: OpenClawCorrelation;
};

type ProxyFailureArchiveInput = Omit<
  ProxyArchiveHookInput,
  'status' | 'upstreamStatus' | 'errorCode'
> & {
  failure: AttemptFailure;
  status?: 'failed' | 'partial';
};

function requestSeed(requestId: string): number {
  let seed = 0;
  for (let i = 0; i < requestId.length; i += 1) {
    seed = (seed * 31 + requestId.charCodeAt(i)) >>> 0;
  }
  return seed;
}

function orderCredentialsForRequest(credentials: TokenCredential[], requestId: string): TokenCredential[] {
  if (credentials.length <= 1) return credentials;
  const offset = requestSeed(requestId) % credentials.length;
  return [...credentials.slice(offset), ...credentials.slice(0, offset)];
}

function normalizeBuyerLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findUniqueBuyerLabelMatchedCredentialId(
  credentials: TokenCredential[],
  buyerKeyLabel: string | null | undefined
): string | null {
  const normalizedBuyerKeyLabel = normalizeBuyerLabel(buyerKeyLabel);
  if (!normalizedBuyerKeyLabel) return null;

  let matchedCredentialId: string | null = null;
  for (const credential of credentials) {
    if (!isAnthropicOauthTokenCredential(credential)) continue;
    if (normalizeBuyerLabel(credential.debugLabel) !== normalizedBuyerKeyLabel) continue;
    if (matchedCredentialId !== null) return null;
    matchedCredentialId = credential.id;
  }

  return matchedCredentialId;
}

function isProviderUsageWindowExhausted(utilizationRatio: unknown): boolean {
  return typeof utilizationRatio === 'number' && utilizationRatio >= 1;
}

function evaluateOpenAiProviderUsageEligibility(input: {
  credential: TokenCredential;
  snapshot: TokenCredentialProviderUsageSnapshot | null;
  now?: Date;
}): {
  inScope: boolean;
  eligible: boolean;
  exclusionReason:
    | 'usage_exhausted_5h'
    | 'usage_exhausted_7d'
    | 'provider_usage_snapshot_missing'
    | 'provider_usage_snapshot_soft_stale'
    | 'provider_usage_snapshot_hard_stale'
    | 'contribution_cap_exhausted_5h'
    | 'contribution_cap_exhausted_7d'
    | null;
  routeDecisionMeta: Record<string, unknown>;
} {
  const inScope = isOpenAiProviderUsageRefreshCredential(input.credential);
  const fiveHourReservePercent = input.credential.fiveHourReservePercent ?? 0;
  const sevenDayReservePercent = input.credential.sevenDayReservePercent ?? 0;
  const fiveHourSharedThresholdPercent = 100 - fiveHourReservePercent;
  const sevenDaySharedThresholdPercent = 100 - sevenDayReservePercent;
  const baseMeta: Record<string, unknown> = {
    openaiProviderUsageInScope: inScope,
    fiveHourReservePercent,
    sevenDayReservePercent,
    fiveHourSharedThresholdPercent,
    sevenDaySharedThresholdPercent
  };
  if (!inScope) {
    return {
      inScope,
      eligible: true,
      exclusionReason: null,
      routeDecisionMeta: baseMeta
    };
  }

  if (!input.snapshot) {
    return {
      inScope,
      eligible: false,
      exclusionReason: 'provider_usage_snapshot_missing',
      routeDecisionMeta: {
        ...baseMeta,
        providerUsageSnapshotState: 'missing',
        providerUsageFetchedAt: null,
        fiveHourUtilizationRatio: null,
        fiveHourResetsAt: null,
        fiveHourSharedThresholdPercent,
        fiveHourContributionCapExhausted: false,
        fiveHourProviderUsageExhausted: false,
        sevenDayUtilizationRatio: null,
        sevenDayResetsAt: null,
        sevenDaySharedThresholdPercent,
        sevenDayContributionCapExhausted: false,
        sevenDayProviderUsageExhausted: false,
        providerUsageExhaustionReason: null,
        providerUsageExhaustionHoldActive: false,
        providerUsageExhaustionHoldUntil: null
      }
    };
  }

  const now = input.now ?? new Date();
  const ageMs = Math.max(0, now.getTime() - input.snapshot.fetchedAt.getTime());
  const softStaleMs = readTokenCredentialProviderUsageSoftStaleMs();
  const hardStaleMs = readTokenCredentialProviderUsageHardStaleMs();
  const isHardStale = ageMs > hardStaleMs;
  const isSoftStale = !isHardStale && ageMs > softStaleMs;
  const exhaustionHold = readClaudeProviderUsageExhaustionHoldState({
    fiveHourUtilizationRatio: input.snapshot.fiveHourUtilizationRatio,
    fiveHourResetsAt: input.snapshot.fiveHourResetsAt,
    sevenDayUtilizationRatio: input.snapshot.sevenDayUtilizationRatio,
    sevenDayResetsAt: input.snapshot.sevenDayResetsAt,
    now
  });
  const fiveHourContributionCapExhausted = fiveHourReservePercent > 0
    && typeof input.snapshot.fiveHourUtilizationRatio === 'number'
    && (input.snapshot.fiveHourUtilizationRatio * 100) >= fiveHourSharedThresholdPercent;
  const sevenDayContributionCapExhausted = sevenDayReservePercent > 0
    && typeof input.snapshot.sevenDayUtilizationRatio === 'number'
    && (input.snapshot.sevenDayUtilizationRatio * 100) >= sevenDaySharedThresholdPercent;
  const routeDecisionMeta = {
    ...baseMeta,
    providerUsageSnapshotState: isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
    providerUsageFetchedAt: input.snapshot.fetchedAt.toISOString(),
    fiveHourUtilizationRatio: input.snapshot.fiveHourUtilizationRatio,
    fiveHourResetsAt: input.snapshot.fiveHourResetsAt?.toISOString() ?? null,
    fiveHourContributionCapExhausted,
    fiveHourProviderUsageExhausted: exhaustionHold.fiveHourProviderUsageExhausted,
    sevenDayUtilizationRatio: input.snapshot.sevenDayUtilizationRatio,
    sevenDayResetsAt: input.snapshot.sevenDayResetsAt?.toISOString() ?? null,
    sevenDayContributionCapExhausted,
    sevenDayProviderUsageExhausted: exhaustionHold.sevenDayProviderUsageExhausted,
    providerUsageExhaustionReason: exhaustionHold.reason,
    providerUsageExhaustionHoldActive: exhaustionHold.hasActiveHold,
    providerUsageExhaustionHoldUntil: exhaustionHold.nextRefreshAt?.toISOString() ?? null
  };

  if (exhaustionHold.hasActiveHold) {
    return {
      inScope,
      eligible: false,
      exclusionReason: exhaustionHold.reason,
      routeDecisionMeta
    };
  }

  if (isHardStale) {
    return {
      inScope,
      eligible: false,
      exclusionReason: 'provider_usage_snapshot_hard_stale',
      routeDecisionMeta
    };
  }

  if (isSoftStale) {
    return {
      inScope,
      eligible: false,
      exclusionReason: 'provider_usage_snapshot_soft_stale',
      routeDecisionMeta
    };
  }

  if (fiveHourContributionCapExhausted) {
    return {
      inScope,
      eligible: false,
      exclusionReason: 'contribution_cap_exhausted_5h',
      routeDecisionMeta
    };
  }

  if (sevenDayContributionCapExhausted) {
    return {
      inScope,
      eligible: false,
      exclusionReason: 'contribution_cap_exhausted_7d',
      routeDecisionMeta
    };
  }

  return {
    inScope,
    eligible: true,
    exclusionReason: null,
    routeDecisionMeta
  };
}

function buildRequestId(headerValue: string | undefined): string {
  return headerValue || `req_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function readHeader(req: any, ...names: string[]): string | undefined {
  for (const name of names) {
    const raw = req.header(name);
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function resolveOpenClawCorrelation(req: any, requestId: string): OpenClawCorrelation {
  const bodyObject = req.body && typeof req.body === 'object'
    ? (req.body as any)
    : undefined;
  const metadata = bodyObject?.metadata ?? bodyObject?.payload?.metadata;
  const metadataRunId = typeof metadata?.openclaw_run_id === 'string'
    ? metadata.openclaw_run_id.trim()
    : undefined;
  const metadataSessionId = typeof metadata?.openclaw_session_id === 'string'
    ? metadata.openclaw_session_id.trim()
    : undefined;
  const explicitRunId = readHeader(req, 'x-openclaw-run-id', 'openclaw-run-id', 'x-run-id')
    ?? (metadataRunId && metadataRunId.length > 0 ? metadataRunId : undefined);
  const explicitSessionId = readHeader(req, 'x-openclaw-session-id', 'openclaw-session-id', 'x-session-id')
    ?? (metadataSessionId && metadataSessionId.length > 0 ? metadataSessionId : undefined);
  return {
    openclawRunId: explicitRunId ?? `run_${requestId}`,
    openclawSessionId: explicitSessionId,
    sourceExplicit: Boolean(explicitRunId || explicitSessionId)
  };
}

function extractProxyPath(originalUrl: string): string {
  const marker = '/v1/proxy/';
  const idx = originalUrl.indexOf(marker);
  if (idx < 0) return '/';
  const rest = originalUrl.slice(idx + marker.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

function isWrappedProxyRequestBody(body: unknown): body is Record<string, unknown> {
  return Boolean(
    body
    && typeof body === 'object'
    && !Array.isArray(body)
    && (
      Object.prototype.hasOwnProperty.call(body, 'provider')
      || Object.prototype.hasOwnProperty.call(body, 'streaming')
      || Object.prototype.hasOwnProperty.call(body, 'payload')
    )
  );
}

function parseProxyRequestBody(body: unknown, proxiedPath: string) {
  if (isWrappedProxyRequestBody(body)) {
    return proxyRequestSchema.parse(body);
  }

  const parsedPath = parseRelativeProxyUrl(proxiedPath);
  if (parsedPath.pathname === '/v1/messages') {
    const parsed = nativeAnthropicProxyRequestSchema.parse(body);
    return {
      provider: 'anthropic',
      model: parsed.model,
      streaming: parsed.stream === true,
      payload: parsed
    };
  }

  if (parsedPath.pathname === '/v1/responses') {
    const parsed = nativeOpenAiResponsesRequestSchema.parse(body);
    return {
      provider: 'openai',
      model: parsed.model,
      streaming: parsed.stream !== false,
      payload: parsed
    };
  }

  return proxyRequestSchema.parse(body);
}

function upstreamBaseUrl(provider: string): string {
  const normalizedProvider = canonicalizeProvider(provider);
  if (normalizedProvider === 'anthropic') {
    return process.env.ANTHROPIC_UPSTREAM_BASE_URL || 'https://api.anthropic.com';
  }
  if (normalizedProvider === 'openai') {
    return process.env.OPENAI_UPSTREAM_BASE_URL || 'https://api.openai.com';
  }

  throw new AppError('model_invalid', 400, `Unsupported provider: ${normalizedProvider}`);
}

function inferErrorCode(error: AttemptFailure): string {
  if (error.kind) return error.kind;
  if (error.statusCode) return `upstream_${error.statusCode}`;
  return 'upstream_unknown';
}

function isTokenModeEnabledForOrg(orgId: string): boolean {
  const allowlist = process.env.TOKEN_MODE_ENABLED_ORGS;
  if (!allowlist) return false;
  const enabled = new Set(
    allowlist
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
  return enabled.has(orgId);
}

function isTokenModePolicyActive(): boolean {
  const allowlist = process.env.TOKEN_MODE_ENABLED_ORGS;
  if (!allowlist) return false;
  return allowlist
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean).length > 0;
}

function canonicalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'codex') return 'openai';
  return normalized;
}

function alternateProvider(provider: string): string {
  return canonicalizeProvider(provider) === 'openai' ? 'anthropic' : 'openai';
}

function resolveDefaultBuyerProvider(): string {
  const raw = String(process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT || 'anthropic')
    .trim()
    .toLowerCase();
  const normalized = canonicalizeProvider(raw);
  return normalized === 'openai' ? 'openai' : 'anthropic';
}

function isClaudeCliPinnedRequest(req: any, proxiedPath: string): boolean {
  if (!proxiedPath.startsWith('/v1/messages')) return false;
  const appHeader = readHeader(req, 'x-app');
  if (!appHeader || appHeader.trim().toLowerCase() !== 'cli') return false;
  const userAgent = readHeader(req, 'user-agent');
  return Boolean(userAgent && userAgent.trim().toLowerCase().startsWith('claude-cli/'));
}

function shouldLockTokenModeProviderPlanToRequestProvider(input: {
  compatMode: boolean;
  proxiedPath: string;
  requestProvider: string;
}): boolean {
  if (input.compatMode) return false;
  if (canonicalizeProvider(input.requestProvider) !== 'openai') return false;
  return parseRelativeProxyUrl(input.proxiedPath).pathname === '/v1/responses';
}

function parseProviderPreferencePlan(input: {
  preferredProvider?: string | null;
  preferredProviderSource?: 'explicit' | 'default' | null;
  requestProvider: string;
  pinSelectionReason?: ProviderSelectionReason | null;
  forceRequestProviderPlan?: boolean;
}): {
  providerPlan: string[];
  preferredProvider: string;
  pinSelectionReason?: ProviderSelectionReason;
} {
  const requestProvider = canonicalizeProvider(input.requestProvider);
  if (input.pinSelectionReason || input.forceRequestProviderPlan) {
    return {
      providerPlan: [requestProvider],
      preferredProvider: requestProvider,
      ...(input.pinSelectionReason ? { pinSelectionReason: input.pinSelectionReason } : {})
    };
  }

  const preferredProvider = input.preferredProvider
    ? canonicalizeProvider(input.preferredProvider)
    : resolveDefaultBuyerProvider();
  const deduped = Array.from(new Set([preferredProvider, alternateProvider(preferredProvider)]));
  return {
    providerPlan: deduped,
    preferredProvider: deduped[0]
  };
}

function selectSameProviderRetryCredentials(credentials: TokenCredential[]): TokenCredential[] {
  return credentials.slice(0, 2);
}

function shouldExpandSameProviderRetryBudget(failure: AttemptFailure): boolean {
  return failure.kind === 'server_error' || failure.kind === 'network';
}

function buildTokenCredentialAttemptsExhaustedError(input: {
  provider: string;
  model: string;
  compatTerminalResult?: ProxyRouteResult | null;
  lastRetryableFailure?: AttemptFailure | null;
  sawRateLimitFailure?: boolean;
}): AppError {
  const {
    provider,
    model,
    compatTerminalResult,
    lastRetryableFailure,
    sawRateLimitFailure
  } = input;
  const baseDetails: Record<string, unknown> = {
    provider,
    model,
    ...(compatTerminalResult ? { compatTerminalResult } : {})
  };

  if (lastRetryableFailure && !sawRateLimitFailure) {
    const status = lastRetryableFailure.kind === 'server_error'
      ? (lastRetryableFailure.statusCode && lastRetryableFailure.statusCode >= 500
        ? lastRetryableFailure.statusCode
        : 503)
      : 502;
    return new AppError(
      'upstream_error',
      status,
      lastRetryableFailure.kind === 'network'
        ? 'All token credential attempts exhausted after upstream network failures'
        : 'All token credential attempts exhausted after upstream server errors',
      {
        ...baseDetails,
        lastFailureKind: lastRetryableFailure.kind ?? null,
        lastUpstreamStatus: lastRetryableFailure.statusCode ?? null
      }
    );
  }

  return new AppError('capacity_unavailable', 429, 'All token credential attempts exhausted', baseDetails);
}

function resolveProviderSelectionReason(input: {
  provider: string;
  preferredProvider: string;
  fallbackFromProvider?: string;
  pinSelectionReason?: ProviderSelectionReason;
}): ProviderSelectionReason {
  if (input.pinSelectionReason) return input.pinSelectionReason;
  if (input.fallbackFromProvider || input.provider !== input.preferredProvider) {
    return 'fallback_provider_selected';
  }
  return 'preferred_provider_selected';
}

function readProviderPinSignal(req: any): boolean {
  const headerValue = readHeader(req, 'x-innies-provider-pin', 'innies-provider-pin');
  if (headerValue) {
    const normalized = headerValue.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  }

  const bodyObject = req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : undefined;
  const metadata = (bodyObject?.metadata && typeof bodyObject.metadata === 'object'
    ? bodyObject.metadata
    : undefined)
    ?? (
      bodyObject?.payload
      && typeof bodyObject.payload === 'object'
      && (bodyObject.payload as any).metadata
      && typeof (bodyObject.payload as any).metadata === 'object'
        ? (bodyObject.payload as any).metadata
        : undefined
    );
  const metadataValue = (metadata as Record<string, unknown> | undefined)?.innies_provider_pin;
  return metadataValue === true || metadataValue === 'true' || metadataValue === 1;
}

async function assertTokenProviderEligible(input: {
  provider: string;
  model: string;
  streaming: boolean;
}): Promise<void> {
  const { provider, model, streaming } = input;
  if (await runtime.repos.killSwitch.isDisabled('model', `${provider}:${model}`)) {
    throw new AppError('suspended', 423, 'Model is disabled', { provider, model });
  }

  const compatible = await runtime.repos.modelCompatibility.findActive(provider, model);
  if (!compatible) {
    throw new AppError('model_invalid', 400, 'No active compatibility rule for provider/model', { provider, model });
  }
  if (streaming && !compatible.supports_streaming) {
    throw new AppError('model_invalid', 400, 'Streaming not supported for provider/model', { provider, model });
  }
}

function providerFallbackReasonForError(error: unknown): string | null {
  if (!(error instanceof AppError)) return null;
  if (error.code === 'unauthorized') return 'auth_failure';
  if (error.code === 'capacity_unavailable') return 'capacity_unavailable';
  if (error.code === 'upstream_error') return 'upstream_error';
  if (error.code === 'model_invalid') return 'model_invalid';
  if (error.code === 'suspended') return 'provider_unavailable';
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upstreamTimeoutMs(): number {
  const parsed = Number(process.env.UPSTREAM_TIMEOUT_MS || 300000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
}

function sseHeartbeatIntervalMs(): number {
  const parsed = Number(process.env.SSE_HEARTBEAT_INTERVAL_MS || 1500);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
}

function tokenCredentialMaxedFailureThreshold(): number {
  const parsed = Number(process.env.TOKEN_CREDENTIAL_MAXED_CONSECUTIVE_FAILURES || 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

function tokenCredentialProbeIntervalMinutes(): number {
  const minutes = process.env.TOKEN_CREDENTIAL_PROBE_INTERVAL_MINUTES;
  if (minutes) {
    const parsedMinutes = Number(minutes);
    return Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? Math.floor(parsedMinutes) : 10;
  }

  const legacyHours = process.env.TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS;
  if (legacyHours) {
    const parsedHours = Number(legacyHours);
    return Number.isFinite(parsedHours) && parsedHours > 0 ? Math.floor(parsedHours * 60) : 10;
  }

  return 10;
}

function tokenCredentialRateLimitThreshold(): number {
  const parsed = Number(process.env.TOKEN_CREDENTIAL_RATE_LIMIT_CONSECUTIVE_FAILURES || 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

function tokenCredentialRateLimitCooldownMinutes(): number {
  const parsed = Number(process.env.TOKEN_CREDENTIAL_RATE_LIMIT_COOLDOWN_MINUTES || 5);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

function tokenCredentialMaxStatuses(): Set<number> {
  const raw = process.env.TOKEN_CREDENTIAL_MAX_ON_STATUSES || '401';
  const parsed = new Set<number>();
  for (const chunk of raw.split(',')) {
    const code = Number(chunk.trim());
    if (code === 401 || code === 403) parsed.add(code);
  }
  if (parsed.size === 0) parsed.add(401);
  return parsed;
}

function isOauthCredential(credential: TokenCredential, provider: string): boolean {
  return isOpenAiOauthToken(credential, provider) || isAnthropicOauthToken(credential, provider);
}

const ANTHROPIC_DEFAULT_BETAS = [
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14'
] as const;

const ANTHROPIC_OAUTH_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  ...ANTHROPIC_DEFAULT_BETAS
] as const;

const CLAUDE_CODE_IDENTITY_SYSTEM_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";

function parseAnthropicBetaHeader(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isAnthropicOauthAccessToken(provider: string, accessToken: string): boolean {
  return provider === 'anthropic' && accessToken.includes('sk-ant-oat');
}

function isOpenAiProvider(provider: string): boolean {
  return canonicalizeProvider(provider) === 'openai';
}

function isOpenAiOauthToken(credential: TokenCredential, provider: string): boolean {
  return isOpenAiProvider(provider) && isOpenAiOauthAccessToken(credential.accessToken);
}

function isAnthropicOauthToken(credential: TokenCredential, provider: string): boolean {
  return isAnthropicOauthAccessToken(provider, credential.accessToken);
}

function buildTokenModeUpstreamHeaders(input: {
  requestId: string;
  anthropicVersion: string;
  anthropicBeta?: string;
  provider: string;
  credential: TokenCredential;
  skipOauthDefaultBetas?: boolean;
  streaming?: boolean;
}): Record<string, string> {
  const {
    requestId,
    anthropicVersion,
    anthropicBeta,
    provider,
    credential,
    skipOauthDefaultBetas,
    streaming
  } = input;
  const authHeaders = isAnthropicOauthAccessToken(provider, credential.accessToken) || isOpenAiProvider(provider)
    ? { authorization: `Bearer ${credential.accessToken}` }
    : mapAuthHeader(credential.authScheme, credential.accessToken);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': requestId,
    ...authHeaders
  };
  if (isOpenAiOauthToken(credential, provider)) {
    const accountId = resolveOpenAiOauthAccountId(credential.accessToken);
    if (accountId) {
      headers['chatgpt-account-id'] = accountId;
    }
  }
  if (provider === 'anthropic') {
    headers['anthropic-version'] = anthropicVersion;
  }
  if (streaming) {
    headers.accept = 'text/event-stream';
  }

  const shouldIncludeOauthBetas = !skipOauthDefaultBetas && isAnthropicOauthToken(credential, provider);
  const inboundBetas = parseAnthropicBetaHeader(anthropicBeta ?? '');
  if (inboundBetas.length > 0 || shouldIncludeOauthBetas) {
    const mergedBetas = new Set<string>(inboundBetas);
    if (shouldIncludeOauthBetas) {
      for (const beta of ANTHROPIC_OAUTH_BETAS) mergedBetas.add(beta);
    }
    headers['anthropic-beta'] = [...mergedBetas].join(',');
  }

  return headers;
}

function isUpstreamBlockedResponse(status: number, data: unknown): boolean {
  if (status !== 403 || !data || typeof data !== 'object') return false;
  const message = String((data as any)?.error?.message ?? '').toLowerCase();
  return message.includes('your request was blocked');
}

function sanitizeCompatPayloadForBlockedRetry(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...(payload as Record<string, unknown>) };
  // Compatibility fallback: remove extended-thinking block on blocked-policy retry.
  delete next.thinking;
  return next;
}

type CompatNormalizationReason =
  | 'retry_blocked_403'
  | 'retry_oauth_401';

type CompatNormalizationState = {
  payload: unknown;
  anthropicBeta?: string;
  blockedRetryApplied: boolean;
  oauthRetryApplied: boolean;
};

function createCompatNormalizationState(payload: unknown, anthropicBeta?: string): CompatNormalizationState {
  return {
    payload,
    anthropicBeta,
    blockedRetryApplied: false,
    oauthRetryApplied: false
  };
}

function applyCompatNormalization(input: {
  requestId: string;
  attemptNo: number;
  credentialId: string;
  provider: string;
  credential: TokenCredential;
  state: CompatNormalizationState;
  reason: CompatNormalizationReason;
}): CompatNormalizationState {
  const { requestId, attemptNo, credentialId, provider, credential, state, reason } = input;
  const nextState: CompatNormalizationState = { ...state };
  const beforeShape = payloadLooksLikeToolStreaming(state.payload);
  const beforeBeta = state.anthropicBeta;

  if (reason === 'retry_oauth_401') {
    nextState.payload = sanitizeCompatPayloadForOauthAuthRetry(nextState.payload);
    nextState.oauthRetryApplied = true;
  } else if (reason === 'retry_blocked_403') {
    nextState.payload = sanitizeCompatPayloadForBlockedRetry(nextState.payload);
    nextState.anthropicBeta = undefined;
    nextState.blockedRetryApplied = true;
  }

  if (reason === 'retry_oauth_401' && isAnthropicOauthToken(credential, provider)) {
    const merged = new Set<string>([
      ...parseAnthropicBetaHeader(nextState.anthropicBeta ?? ''),
      ...ANTHROPIC_OAUTH_BETAS
    ]);
    nextState.anthropicBeta = [...merged].join(',');
  }

  if (process.env.COMPAT_NORMALIZATION_LOG === '1') {
    console.info('[compat-normalization] applied', {
      requestId,
      attemptNo,
      credentialId,
      reason,
      flags: {
        blockedRetryApplied: nextState.blockedRetryApplied,
        oauthRetryApplied: nextState.oauthRetryApplied
      },
      before: {
        payloadLooksToolStreaming: beforeShape,
        anthropicBeta: beforeBeta
      },
      after: {
        payloadLooksToolStreaming: payloadLooksLikeToolStreaming(nextState.payload),
        anthropicBeta: nextState.anthropicBeta
      }
    });
  }

  return nextState;
}

function sanitizeCompatPayloadForOauthAuthRetry(payload: unknown): unknown {
  // Parity behavior: keep original OpenClaw payload shape for oauth retries.
  return payload;
}

function isOauthUnsupportedAuthError(status: number, errorMessage?: string): boolean {
  if (status !== 401) return false;
  if (!errorMessage) return false;
  return errorMessage.toLowerCase().includes('oauth authentication is currently not supported');
}

function payloadLooksLikeToolStreaming(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.stream === true
    || Array.isArray(p.tools)
    || p.tool_choice != null
  );
}

function shouldRetryWithOauthSafeCompatPayload(input: {
  status: number;
  strictUpstreamPassthrough?: boolean;
  provider: string;
  credential: TokenCredential;
  alreadyRetried: boolean;
  payload: unknown;
  anthropicBeta?: string;
  errorType?: string;
  errorMessage?: string;
}): boolean {
  const {
    status,
    strictUpstreamPassthrough,
    provider,
    credential,
    alreadyRetried,
    payload,
    anthropicBeta,
    errorType,
    errorMessage
  } = input;
  if (!strictUpstreamPassthrough) return false;
  if (alreadyRetried) return false;
  if (!isAnthropicOauthToken(credential, provider)) return false;
  if (status !== 401) return false;

  if (isOauthUnsupportedAuthError(status, errorMessage)) return true;

  const isAuthErrorType = (errorType ?? '').toLowerCase() === 'authentication_error';
  const betaIncludesToolStreaming = String(anthropicBeta ?? '')
    .toLowerCase()
    .includes('fine-grained-tool-streaming');

  return isAuthErrorType && (payloadLooksLikeToolStreaming(payload) || betaIncludesToolStreaming);
}

function extractUpstreamErrorDetails(data: unknown): { errorType?: string; errorMessage?: string } {
  if (!data || typeof data !== 'object') return {};
  const error = (data as any).error;
  if (!error || typeof error !== 'object') return {};
  const errorType = typeof error.type === 'string' ? error.type : undefined;
  const errorMessage = typeof error.message === 'string' ? error.message : undefined;
  return { errorType, errorMessage };
}

function logCompatAudit(input: {
  orgId: string;
  provider: string;
  model: string;
  requestId: string;
  credentialId: string;
  attemptNo: number;
  upstreamStatus: number;
  openclawRunId: string;
  openclawSessionId?: string;
  errorType?: string;
  errorMessage?: string;
}): void {
  // Keep this concise and machine-parsable for incident correlation.
  console.info('[compat-audit] attempt', input);
}

function logCompatTranslatedUpstreamError(input: {
  requestId: string;
  credentialId: string;
  credentialLabel?: string | null;
  provider: string;
  model: string;
  translatedPath: string;
  translatedModel: string;
  upstreamStatus: number;
  upstreamContentType?: string;
  upstreamError: unknown;
}): void {
  console.warn('[compat-translated-upstream-error]', {
    request_id: input.requestId,
    credential_id: input.credentialId,
    credential_label: input.credentialLabel ?? null,
    provider: input.provider,
    model: input.model,
    translated_path: input.translatedPath,
    translated_model: input.translatedModel,
    upstream_status: input.upstreamStatus,
    upstream_content_type: input.upstreamContentType ?? null,
    upstream_error: input.upstreamError
  });
}

function logRetryAudit(input: {
  orgId: string;
  provider: string;
  model: string;
  requestId: string;
  openclawRunId: string;
  openclawSessionId?: string;
  attemptNo: number;
  credentialId: string;
  credentialLabel?: string | null;
  upstreamStatus: number;
  retryReason: RetryReason;
}): void {
  console.info('[retry-audit] attempt', {
    org_id: input.orgId,
    provider: input.provider,
    model: input.model,
    request_id: input.requestId,
    openclaw_run_id: input.openclawRunId,
    openclaw_session_id: input.openclawSessionId,
    attempt_no: input.attemptNo,
    credential_id: input.credentialId,
    credential_label: input.credentialLabel ?? null,
    upstream_status: input.upstreamStatus,
    retry_reason: input.retryReason
  });
}

function logAuthFailureAudit(input: {
  orgId: string;
  provider: string;
  model: string;
  requestId: string;
  openclawRunId: string;
  openclawSessionId?: string;
  attemptNo: number;
  credentialId: string;
  credentialLabel?: string | null;
  upstreamStatus: number;
  errorType?: string;
  errorMessage?: string;
}): void {
  console.warn('[auth-failure-audit] attempt', {
    org_id: input.orgId,
    provider: input.provider,
    model: input.model,
    request_id: input.requestId,
    openclaw_run_id: input.openclawRunId,
    openclaw_session_id: input.openclawSessionId,
    attempt_no: input.attemptNo,
    credential_id: input.credentialId,
    credential_label: input.credentialLabel ?? null,
    upstream_status: input.upstreamStatus,
    error_type: input.errorType,
    error_message: input.errorMessage
  });
}

function resolveRequestSource(input: {
  provider: string;
  selectionReason: ProviderSelectionReason;
  correlation: OpenClawCorrelation;
}): RequestSource {
  if (input.selectionReason === 'cli_provider_pinned') {
    return canonicalizeProvider(input.provider) === 'openai' ? 'cli-codex' : 'cli-claude';
  }

  return input.correlation.sourceExplicit ? 'openclaw' : 'direct';
}

function buildTokenRouteDecision(
  credential: TokenCredential,
  correlation: OpenClawCorrelation,
  providerPreference?: ProviderPreferenceMeta,
  compatTranslation?: CompatTranslationMeta,
  providerUsageMeta?: Record<string, unknown>,
  rescueMeta?: Record<string, unknown>
): Record<string, unknown> {
  const selectionReason = providerPreference?.selectionReason ?? 'preferred_provider_selected';
  const decision: Record<string, unknown> = {
    reason: selectionReason,
    provider_selection_reason: selectionReason,
    request_source: resolveRequestSource({
      provider: credential.provider,
      selectionReason,
      correlation
    }),
    tokenCredentialId: credential.id,
    tokenCredentialLabel: credential.debugLabel ?? null,
    tokenAuthScheme: credential.authScheme,
    openclaw_run_id: correlation.openclawRunId,
    openclaw_session_id: correlation.openclawSessionId ?? null
  };
  if (providerPreference) {
    decision.provider_preferred = providerPreference.preferredProvider;
    decision.provider_effective = providerPreference.effectiveProvider;
    decision.provider_plan = providerPreference.providerPlan;
    decision.provider_fallback_from = providerPreference.fallbackFromProvider ?? null;
    decision.provider_fallback_reason = providerPreference.fallbackReason ?? null;
  }
  if (compatTranslation) {
    decision.translated = true;
    decision.translation_strategy = compatTranslation.strategy;
    decision.original_provider = compatTranslation.originalProvider;
    decision.original_model = compatTranslation.originalModel;
    decision.original_path = compatTranslation.originalPath;
    decision.translated_path = compatTranslation.translatedPath;
    decision.translated_model = compatTranslation.translatedModel;
  }
  if (providerUsageMeta) {
    Object.assign(decision, providerUsageMeta);
  }
  if (rescueMeta) {
    Object.assign(decision, rescueMeta);
  }
  return decision;
}

function rememberRescueFailure(
  tracker: RescueTracker | undefined,
  input: {
    provider: string;
    credential: TokenCredential;
    attemptNo: number;
    failure: AttemptFailure;
  }
): void {
  if (!tracker || tracker.firstFailure) return;
  tracker.firstFailure = {
    provider: canonicalizeProvider(input.provider),
    credentialId: input.credential.id,
    credentialLabel: input.credential.debugLabel ?? null,
    attemptNo: input.attemptNo,
    failureCode: inferErrorCode(input.failure),
    failureStatus: input.failure.statusCode ?? null
  };
}

function buildRescueRouteDecisionMeta(
  tracker: RescueTracker | undefined,
  input: {
    provider: string;
    credential: TokenCredential;
  }
): Record<string, unknown> {
  const initialFailure = tracker?.firstFailure ?? null;
  if (!initialFailure) {
    return {
      rescued: false,
      rescue_scope: null
    };
  }

  const finalProvider = canonicalizeProvider(input.provider);
  const rescueScope: RescueScope = initialFailure.provider === finalProvider
    ? 'same_provider'
    : 'cross_provider';

  return {
    rescued: true,
    rescue_scope: rescueScope,
    rescue_initial_provider: initialFailure.provider,
    rescue_initial_credential_id: initialFailure.credentialId,
    rescue_initial_credential_label: initialFailure.credentialLabel ?? null,
    rescue_initial_attempt_no: initialFailure.attemptNo,
    rescue_initial_failure_code: initialFailure.failureCode,
    rescue_initial_failure_status: initialFailure.failureStatus,
    rescue_final_provider: finalProvider,
    rescue_final_credential_id: input.credential.id,
    rescue_final_credential_label: input.credential.debugLabel ?? null
  };
}

function logDegradedSuccess(input: {
  tracker: RescueTracker | undefined;
  requestId: string;
  orgId: string;
  correlation: OpenClawCorrelation;
  provider: string;
  model: string;
  credential: TokenCredential;
  attemptNo: number;
}): void {
  const initialFailure = input.tracker?.firstFailure ?? null;
  if (!initialFailure) return;

  const rescueScope: RescueScope = initialFailure.provider === canonicalizeProvider(input.provider)
    ? 'same_provider'
    : 'cross_provider';

  console.info('[degraded_success]', {
    org_id: input.orgId,
    request_id: input.requestId,
    openclaw_run_id: input.correlation.openclawRunId,
    openclaw_session_id: input.correlation.openclawSessionId ?? null,
    provider: input.provider,
    model: input.model,
    final_attempt_no: input.attemptNo,
    rescue_scope: rescueScope,
    initial_provider: initialFailure.provider,
    initial_credential_id: initialFailure.credentialId,
    initial_credential_label: initialFailure.credentialLabel ?? null,
    initial_attempt_no: initialFailure.attemptNo,
    initial_failure_code: initialFailure.failureCode,
    initial_failure_status: initialFailure.failureStatus,
    final_provider: canonicalizeProvider(input.provider),
    final_credential_id: input.credential.id,
    final_credential_label: input.credential.debugLabel ?? null
  });
}

async function resolveEligibleTokenCredentials(input: {
  orgId: string;
  provider: string;
  requestId: string;
  buyerKeyLabel?: string | null;
}): Promise<{
  credentials: TokenCredential[];
  providerUsageRouteMeta: Map<string, Record<string, unknown>>;
  providerUsageExcludedReasonCounts: Record<string, number>;
  providerUsageExcludedRouteMeta: Record<string, Record<string, unknown>>;
  anthropicStaleRecoveryCandidate: TokenCredential | null;
}> {
  const canonicalProvider = canonicalizeProvider(input.provider);
  const seededCredentials = orderCredentialsForRequest(
    await runtime.repos.tokenCredentials.listActiveForRouting(input.orgId, input.provider),
    input.requestId
  );
  const buyerLabelMatchedCredentialId = canonicalProvider === 'anthropic'
    ? findUniqueBuyerLabelMatchedCredentialId(seededCredentials, input.buyerKeyLabel)
    : null;
  const orderedCredentials = seededCredentials;

  const providerUsageRouteMeta = new Map<string, Record<string, unknown>>();
  if ((canonicalProvider !== 'anthropic' && canonicalProvider !== 'openai') || orderedCredentials.length === 0) {
    return {
      credentials: orderedCredentials,
      providerUsageRouteMeta,
      providerUsageExcludedReasonCounts: {},
      providerUsageExcludedRouteMeta: {},
      anthropicStaleRecoveryCandidate: null
    };
  }

  const snapshots = await runtime.repos.tokenCredentialProviderUsage.listByTokenCredentialIds(
    orderedCredentials.map((credential) => credential.id)
  );
  const snapshotsByCredentialId = new Map(snapshots.map((snapshot) => [snapshot.tokenCredentialId, snapshot]));
  const eligibleCredentials: TokenCredential[] = [];
  const providerUsageExcludedReasonCounts: Record<string, number> = {};
  const providerUsageExcludedRouteMeta: Record<string, Record<string, unknown>> = {};
  let anthropicStaleRecoveryCandidate: TokenCredential | null = null;
  const rateLimitEscalationThreshold = tokenCredentialRateLimitThreshold();

  for (const credential of orderedCredentials) {
    if (canonicalProvider === 'openai') {
      const evaluation = evaluateOpenAiProviderUsageEligibility({
        credential,
        snapshot: snapshotsByCredentialId.get(credential.id) ?? null
      });
      if (evaluation.inScope) {
        providerUsageRouteMeta.set(credential.id, evaluation.routeDecisionMeta);
      }
      if (!evaluation.eligible) {
        const reason = evaluation.exclusionReason ?? 'provider_usage_unknown';
        providerUsageExcludedReasonCounts[reason] = (providerUsageExcludedReasonCounts[reason] ?? 0) + 1;
        providerUsageExcludedRouteMeta[credential.id] = evaluation.routeDecisionMeta;
        continue;
      }

      eligibleCredentials.push(credential);
      continue;
    }

    const evaluation = evaluateClaudeContributionCap({
      credential,
      snapshot: snapshotsByCredentialId.get(credential.id) ?? null
    });
    const repeated429HoldActive = evaluation.inScope
      && credential.consecutiveRateLimitCount >= rateLimitEscalationThreshold
      && (!evaluation.isFresh || !evaluation.eligible);
    const buyerLabelAffinityBypassApplied = buyerLabelMatchedCredentialId === credential.id
      && !repeated429HoldActive
      && (evaluation.exclusionReason === 'contribution_cap_exhausted_5h'
        || evaluation.exclusionReason === 'contribution_cap_exhausted_7d')
      && evaluation.routeDecisionMeta.providerUsageExhaustionHoldActive !== true
      && !isProviderUsageWindowExhausted(evaluation.routeDecisionMeta.fiveHourUtilizationRatio)
      && !isProviderUsageWindowExhausted(evaluation.routeDecisionMeta.sevenDayUtilizationRatio);

    if (evaluation.inScope) {
      providerUsageRouteMeta.set(credential.id, {
        ...evaluation.routeDecisionMeta,
        buyerLabelAffinityMatched: buyerLabelMatchedCredentialId === credential.id,
        buyerLabelAffinityBypassApplied,
        claudeRepeated429LocalBackoffActive: repeated429HoldActive,
        claudeRepeated429ConsecutiveRateLimits: credential.consecutiveRateLimitCount,
        claudeRepeated429EscalationThreshold: rateLimitEscalationThreshold,
        claudeRepeated429RecoveryBlockedBy: repeated429HoldActive
          ? evaluation.exclusionReason ?? evaluation.warningReason ?? CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON
          : null
      });
    }

    if (!evaluation.eligible && !buyerLabelAffinityBypassApplied) {
      const reason = evaluation.exclusionReason ?? 'provider_usage_unknown';
      if (
        anthropicStaleRecoveryCandidate === null
        && !repeated429HoldActive
        && (
          reason === 'provider_usage_snapshot_soft_stale'
          || reason === 'provider_usage_snapshot_hard_stale'
        )
      ) {
        anthropicStaleRecoveryCandidate = credential;
      }
      providerUsageExcludedReasonCounts[reason] = (providerUsageExcludedReasonCounts[reason] ?? 0) + 1;
      if (providerUsageRouteMeta.has(credential.id)) {
        providerUsageExcludedRouteMeta[credential.id] = providerUsageRouteMeta.get(credential.id) as Record<string, unknown>;
      }
      continue;
    }

    if (repeated429HoldActive) {
      providerUsageExcludedReasonCounts[CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON] = (
        providerUsageExcludedReasonCounts[CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON] ?? 0
      ) + 1;
      if (providerUsageRouteMeta.has(credential.id)) {
        providerUsageExcludedRouteMeta[credential.id] = providerUsageRouteMeta.get(credential.id) as Record<string, unknown>;
      }
      continue;
    }

    eligibleCredentials.push(credential);
  }

  return {
    credentials: eligibleCredentials,
    providerUsageRouteMeta,
    providerUsageExcludedReasonCounts,
    providerUsageExcludedRouteMeta,
    anthropicStaleRecoveryCandidate
  };
}

function isCompatProviderUsageFailOpenReason(reason: string): boolean {
  return reason === 'provider_usage_snapshot_missing'
    || reason === 'provider_usage_snapshot_soft_stale'
    || reason === 'provider_usage_snapshot_hard_stale';
}

function shouldCompatFailOpenProviderUsage(input: {
  allowCompatProviderUsageFailOpen?: boolean;
  excludedReasonCounts: Record<string, number>;
}): boolean {
  if (!input.allowCompatProviderUsageFailOpen) return false;
  const reasons = Object.keys(input.excludedReasonCounts);
  return reasons.length > 0 && reasons.every(isCompatProviderUsageFailOpenReason);
}

async function refreshAnthropicCredentialUsageForEligibilityRecovery(input: {
  credential: TokenCredential;
  requestId: string;
  provider: string;
  model: string;
}): Promise<void> {
  const refreshedUsage = await refreshAnthropicOauthUsageWithCredentialRefresh(
    runtime.repos.tokenCredentialProviderUsage,
    runtime.repos.tokenCredentials,
    input.credential,
    { ignoreRetryBackoff: true }
  );
  const credentialForUsage = refreshedUsage.credential;
  const refreshResult = refreshedUsage.outcome;
  const usageAuthFailureStatusCode = anthropicOauthUsageAuthFailureStatusCode(refreshResult);

  if (usageAuthFailureStatusCode !== null) {
    const nextProbeAt = new Date(Date.now() + (tokenCredentialProbeIntervalMinutes() * 60 * 1000));
    await parkAnthropicOauthCredentialAfterUsageAuthFailure(runtime.repos.tokenCredentials, credentialForUsage, {
      statusCode: usageAuthFailureStatusCode,
      nextProbeAt,
      reason: `upstream_${usageAuthFailureStatusCode}_provider_usage_refresh`,
      requestId: input.requestId,
      attemptNo: 0
    });
  }

  try {
    await runtime.repos.tokenCredentials.setProviderUsageWarning(
      credentialForUsage.id,
      usageAuthFailureStatusCode === null
        ? providerUsageWarningReasonFromRefreshOutcome(refreshResult)
        : null
    );
  } catch (error) {
    console.error('[token-credential] provider-usage-warning-sync-failed', {
      request_id: input.requestId,
      attempt_no: 0,
      provider: input.provider,
      model: input.model,
      credential_id: credentialForUsage.id,
      credential_label: credentialForUsage.debugLabel ?? null,
      error_message: error instanceof Error ? error.message : 'unknown'
    });
  }

  if (!refreshResult.ok) return;

  const capState = readClaudeContributionCapSnapshotState({
    credential: credentialForUsage,
    snapshot: refreshResult.snapshot
  });
  if (
    capState.fetchedAt === null
    || capState.fiveHourUtilizationRatio === null
    || capState.sevenDayUtilizationRatio === null
    || capState.fiveHourSharedThresholdPercent === null
    || capState.sevenDaySharedThresholdPercent === null
  ) {
    return;
  }

  try {
    await runtime.repos.tokenCredentials.syncClaudeContributionCapLifecycle({
      id: credentialForUsage.id,
      orgId: credentialForUsage.orgId,
      provider: credentialForUsage.provider,
      snapshotFetchedAt: capState.fetchedAt,
      fiveHourReservePercent: capState.fiveHourReservePercent,
      fiveHourUtilizationRatio: capState.fiveHourUtilizationRatio,
      fiveHourResetsAt: capState.fiveHourResetsAt,
      fiveHourSharedThresholdPercent: capState.fiveHourSharedThresholdPercent,
      fiveHourContributionCapExhausted: capState.fiveHourContributionCapExhausted,
      sevenDayReservePercent: capState.sevenDayReservePercent,
      sevenDayUtilizationRatio: capState.sevenDayUtilizationRatio,
      sevenDayResetsAt: capState.sevenDayResetsAt,
      sevenDaySharedThresholdPercent: capState.sevenDaySharedThresholdPercent,
      sevenDayContributionCapExhausted: capState.sevenDayContributionCapExhausted
    });
  } catch (error) {
    console.error('[token-credential] contribution-cap-lifecycle-sync-failed', {
      request_id: input.requestId,
      attempt_no: 0,
      provider: input.provider,
      model: input.model,
      credential_id: credentialForUsage.id,
      credential_label: credentialForUsage.debugLabel ?? null,
      error_message: error instanceof Error ? error.message : 'unknown'
    });
  }
}

async function resolveEligibleTokenCredentialsWithAnthropicStaleRecovery(input: {
  orgId: string;
  provider: string;
  requestId: string;
  buyerKeyLabel?: string | null;
  model: string;
  allowCompatProviderUsageFailOpen?: boolean;
}): Promise<{
  credentials: TokenCredential[];
  providerUsageRouteMeta: Map<string, Record<string, unknown>>;
  providerUsageExcludedReasonCounts: Record<string, number>;
  providerUsageExcludedRouteMeta: Record<string, Record<string, unknown>>;
  anthropicStaleRecoveryCandidate: TokenCredential | null;
}> {
  const initial = await resolveEligibleTokenCredentials(input);
  if (shouldCompatFailOpenProviderUsage({
    allowCompatProviderUsageFailOpen: input.allowCompatProviderUsageFailOpen,
    excludedReasonCounts: initial.providerUsageExcludedReasonCounts
  })) {
    const seededCredentials = orderCredentialsForRequest(
      await runtime.repos.tokenCredentials.listActiveForRouting(input.orgId, input.provider),
      input.requestId
    );
    if (seededCredentials.length > 0) {
      for (const credential of seededCredentials) {
        const routeMeta = initial.providerUsageRouteMeta.get(credential.id);
        if (!routeMeta) continue;
        initial.providerUsageRouteMeta.set(credential.id, {
          ...routeMeta,
          providerUsageCompatFailOpen: true
        });
      }
      return {
        ...initial,
        credentials: seededCredentials
      };
    }
  }
  if (
    initial.credentials.length > 0
    || canonicalizeProvider(input.provider) !== 'anthropic'
    || initial.anthropicStaleRecoveryCandidate === null
  ) {
    return initial;
  }

  await refreshAnthropicCredentialUsageForEligibilityRecovery({
    credential: initial.anthropicStaleRecoveryCandidate,
    requestId: input.requestId,
    provider: input.provider,
    model: input.model
  });

  return resolveEligibleTokenCredentials(input);
}

function buildSellerRouteDecision(input: {
  routeReason: string;
  provider: string;
  correlation: OpenClawCorrelation;
  pinSelectionReason?: ProviderSelectionReason | null;
}): Record<string, unknown> {
  const selectionReason = input.pinSelectionReason ?? 'preferred_provider_selected';
  return {
    reason: input.routeReason,
    provider_selection_reason: selectionReason,
    request_source: resolveRequestSource({
      provider: input.provider,
      selectionReason,
      correlation: input.correlation
    }),
    openclaw_run_id: input.correlation.openclawRunId,
    openclaw_session_id: input.correlation.openclawSessionId ?? null
  };
}

function buildCompatTerminalErrorResult(input: {
  mappedError: ReturnType<typeof mapOpenAiErrorToAnthropic>;
  requestId: string;
  keyId?: string | null;
  attemptNo: number;
}): ProxyRouteResult {
  return {
    requestId: input.requestId,
    keyId: input.keyId ?? null,
    attemptNo: input.attemptNo,
    upstreamStatus: input.mappedError.status,
    usageUnits: 0,
    contentType: 'application/json',
    data: input.mappedError.body,
    routeKind: 'token_credential',
    alreadyRecorded: true
  };
}

async function readUpstreamErrorPayload(response: globalThis.Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({}));
  }
  return response.text().catch(() => '');
}

async function recordTokenCredentialOutcome(input: {
  credential: TokenCredential;
  requestId: string;
  attemptNo: number;
  provider: string;
  model: string;
  upstreamStatus: number;
}): Promise<void> {
  const { credential, requestId, attemptNo, provider, model, upstreamStatus } = input;
  if (upstreamStatus >= 200 && upstreamStatus < 300) {
    await runtime.repos.tokenCredentials.recordSuccess(credential.id);
    return;
  }
  if (upstreamStatus === 429) {
    if (!isOauthCredential(credential, provider)) return;

    const threshold = tokenCredentialRateLimitThreshold();
    const cooldownUntil = new Date(Date.now() + (tokenCredentialRateLimitCooldownMinutes() * 60 * 1000));

    if (isAnthropicOauthToken(credential, provider)) {
      const escalationCooldownUntil = new Date(
        Date.now() + (readTokenCredentialRateLimitLongBackoffMinutes() * 60 * 1000)
      );
      const result = await runtime.repos.tokenCredentials.recordRateLimitAndApplyCooldown({
        id: credential.id,
        statusCode: upstreamStatus,
        cooldownThreshold: threshold,
        cooldownUntil,
        escalationThreshold: threshold,
        escalationCooldownUntil,
        reason: 'upstream_429_consecutive_rate_limit'
      });

      if (result?.backoffKind === 'extended') {
        const refreshedUsage = await refreshAnthropicOauthUsageWithCredentialRefresh(
          runtime.repos.tokenCredentialProviderUsage,
          runtime.repos.tokenCredentials,
          credential,
          { ignoreRetryBackoff: true }
        );
        const refreshResult = refreshedUsage.outcome;
        const usageAuthFailureStatusCode = anthropicOauthUsageAuthFailureStatusCode(refreshResult);
        if (usageAuthFailureStatusCode !== null) {
          const nextProbeAt = new Date(Date.now() + (tokenCredentialProbeIntervalMinutes() * 60 * 1000));
          await parkAnthropicOauthCredentialAfterUsageAuthFailure(runtime.repos.tokenCredentials, credential, {
            statusCode: usageAuthFailureStatusCode,
            nextProbeAt,
            reason: `upstream_${usageAuthFailureStatusCode}_provider_usage_refresh`,
            requestId,
            attemptNo
          });
        }
        try {
          await runtime.repos.tokenCredentials.setProviderUsageWarning(
            credential.id,
            usageAuthFailureStatusCode === null
              ? providerUsageWarningReasonFromRefreshOutcome(refreshResult)
              : null
          );
        } catch (error) {
          console.error('[token-credential] provider-usage-warning-sync-failed', {
            request_id: requestId,
            attempt_no: attemptNo,
            provider,
            model,
            credential_id: credential.id,
            credential_label: credential.debugLabel ?? null,
            error_message: error instanceof Error ? error.message : 'unknown'
          });
        }
        if (refreshResult.ok) {
          const capState = readClaudeContributionCapSnapshotState({
            credential,
            snapshot: refreshResult.snapshot
          });
          if (
            capState.fetchedAt !== null
            && capState.fiveHourUtilizationRatio !== null
            && capState.sevenDayUtilizationRatio !== null
            && capState.fiveHourSharedThresholdPercent !== null
            && capState.sevenDaySharedThresholdPercent !== null
          ) {
            try {
              await runtime.repos.tokenCredentials.syncClaudeContributionCapLifecycle({
                id: credential.id,
                orgId: credential.orgId,
                provider: credential.provider,
                snapshotFetchedAt: capState.fetchedAt,
                fiveHourReservePercent: capState.fiveHourReservePercent,
                fiveHourUtilizationRatio: capState.fiveHourUtilizationRatio,
                fiveHourResetsAt: capState.fiveHourResetsAt,
                fiveHourSharedThresholdPercent: capState.fiveHourSharedThresholdPercent,
                fiveHourContributionCapExhausted: capState.fiveHourContributionCapExhausted,
                sevenDayReservePercent: capState.sevenDayReservePercent,
                sevenDayUtilizationRatio: capState.sevenDayUtilizationRatio,
                sevenDayResetsAt: capState.sevenDayResetsAt,
                sevenDaySharedThresholdPercent: capState.sevenDaySharedThresholdPercent,
                sevenDayContributionCapExhausted: capState.sevenDayContributionCapExhausted
              });
            } catch (error) {
              console.error('[token-credential] contribution-cap-lifecycle-sync-failed', {
                request_id: requestId,
                attempt_no: attemptNo,
                provider,
                model,
                credential_id: credential.id,
                credential_label: credential.debugLabel ?? null,
                error_message: error instanceof Error ? error.message : 'unknown'
              });
            }
          }
        }
        const evaluation = refreshResult.ok
          ? evaluateClaudeContributionCap({
              credential,
              snapshot: refreshResult.snapshot
            })
          : null;
        const clearedExtendedBackoff = refreshResult.ok
          && evaluation?.inScope === true
          && evaluation.isFresh
          && evaluation.eligible
          ? await runtime.repos.tokenCredentials.clearRateLimitBackoff(credential.id, threshold)
          : false;

        console.warn('[token-credential] cooldown-rate-limit-extended', {
          request_id: requestId,
          attempt_no: attemptNo,
          provider,
          model,
          credential_id: credential.id,
          credential_label: credential.debugLabel ?? null,
          consecutive_rate_limits: result.consecutiveRateLimits,
          threshold,
          escalation_threshold: threshold,
          rate_limited_until: result.rateLimitedUntil?.toISOString() ?? null,
          provider_usage_refresh_ok: refreshResult.ok,
          provider_usage_refresh_reason: refreshResult.ok
            ? evaluation?.exclusionReason ?? evaluation?.warningReason ?? 'healthy'
            : refreshResult.warningReason ?? refreshResult.reason,
          provider_usage_refresh_retry_after_ms: refreshResult.ok ? null : (refreshResult.retryAfterMs ?? null),
          repeated_429_local_backoff_cleared: clearedExtendedBackoff
        });
        return;
      }

      if (result?.backoffKind === 'cooldown') {
        console.warn('[token-credential] cooldown-rate-limit', {
          request_id: requestId,
          attempt_no: attemptNo,
          provider,
          model,
          credential_id: credential.id,
          credential_label: credential.debugLabel ?? null,
          consecutive_rate_limits: result.consecutiveRateLimits,
          threshold,
          rate_limited_until: result.rateLimitedUntil?.toISOString() ?? null
        });
      }
      return;
    }

    const result = await runtime.repos.tokenCredentials.recordRateLimitAndMaybeMax({
      id: credential.id,
      statusCode: upstreamStatus,
      cooldownThreshold: threshold,
      cooldownUntil,
      threshold,
      nextProbeAt: new Date(Date.now() + (tokenCredentialProbeIntervalMinutes() * 60 * 1000)),
      reason: 'upstream_429_consecutive_rate_limit',
      requestId,
      attemptNo
    });

    if (result?.rateLimitedUntil && result.consecutiveRateLimits >= threshold) {
      console.warn('[token-credential] cooldown-rate-limit', {
        request_id: requestId,
        attempt_no: attemptNo,
        provider,
        model,
        credential_id: credential.id,
        credential_label: credential.debugLabel ?? null,
        consecutive_rate_limits: result.consecutiveRateLimits,
        threshold,
        rate_limited_until: result.rateLimitedUntil.toISOString()
      });
    }
    return;
  }
  if (!tokenCredentialMaxStatuses().has(upstreamStatus)) return;

  const baseThreshold = tokenCredentialMaxedFailureThreshold();
  const threshold = isOauthCredential(credential, provider)
    ? baseThreshold * 3
    : baseThreshold;
    const nextProbeAt = new Date(Date.now() + (tokenCredentialProbeIntervalMinutes() * 60 * 1000));
  const result = await runtime.repos.tokenCredentials.recordFailureAndMaybeMax({
    id: credential.id,
    statusCode: upstreamStatus,
    threshold,
    nextProbeAt,
    reason: `upstream_${upstreamStatus}_consecutive_failure`,
    requestId,
    attemptNo
  });

  if (result?.status === 'maxed') {
    console.warn('[token-credential] auto-maxed', {
      request_id: requestId,
      attempt_no: attemptNo,
      provider,
      model,
      credential_id: credential.id,
      credential_label: credential.debugLabel ?? null,
      status: upstreamStatus,
      consecutive_failures: result.consecutiveFailures,
      threshold,
      next_probe_at: nextProbeAt.toISOString()
    });
  }
}

function mapAuthHeader(authScheme: TokenCredential['authScheme'], accessToken: string): Record<string, string> {
  if (authScheme === 'bearer') {
    return { authorization: `Bearer ${accessToken}` };
  }
  return { 'x-api-key': accessToken };
}

function parseRelativeProxyUrl(proxiedPath: string): URL {
  return new URL(proxiedPath, 'https://innies.invalid');
}

function archivePayloadFormatForPath(proxiedPath: string): ArchivePayloadFormat {
  return parseRelativeProxyUrl(proxiedPath).pathname === '/v1/responses'
    ? 'openai_responses'
    : 'anthropic_messages';
}

function buildArchivePayloadSource(proxiedPath: string, payload: unknown): ArchivePayloadSource {
  return {
    format: archivePayloadFormatForPath(proxiedPath),
    payload
  };
}

function buildArchiveAttemptInput(input: ProxyArchiveHookInput): ArchiveAttemptInput {
  return {
    requestId: input.requestId,
    attemptNo: input.attemptNo,
    orgId: input.orgId,
    apiKeyId: input.apiKeyId,
    routeKind: input.routeKind,
    sellerKeyId: input.sellerKeyId ?? null,
    tokenCredentialId: input.tokenCredentialId ?? null,
    provider: input.provider,
    model: input.model,
    streaming: input.streaming,
    status: input.status,
    upstreamStatus: input.upstreamStatus ?? null,
    errorCode: input.errorCode ?? null,
    startedAt: new Date(input.startedAtMs),
    completedAt: new Date(input.completedAtMs ?? Date.now()),
    openclawRunId: input.correlation.openclawRunId,
    openclawSessionId: input.correlation.openclawSessionId ?? null,
    request: buildArchivePayloadSource(input.requestPath, input.requestPayload),
    response: input.responsePayload == null
      ? null
      : buildArchivePayloadSource(input.requestPath, input.responsePayload),
    rawRequest: input.rawRequest ?? input.requestPayload ?? null,
    rawResponse: input.rawResponse ?? (input.streaming ? null : (input.responsePayload ?? null)),
    rawStream: input.rawStream ?? null
  };
}

async function archiveProxyAttempt(input: ProxyArchiveHookInput): Promise<void> {
  await runtime.services.requestArchive.archiveAttempt(buildArchiveAttemptInput(input));
}

async function archiveFailedProxyAttempt(input: ProxyFailureArchiveInput): Promise<void> {
  await archiveProxyAttempt({
    requestId: input.requestId,
    attemptNo: input.attemptNo,
    orgId: input.orgId,
    apiKeyId: input.apiKeyId,
    routeKind: input.routeKind,
    sellerKeyId: input.sellerKeyId ?? null,
    tokenCredentialId: input.tokenCredentialId ?? null,
    provider: input.provider,
    model: input.model,
    streaming: input.streaming,
    status: input.status ?? 'failed',
    upstreamStatus: input.failure.statusCode ?? null,
    errorCode: inferErrorCode(input.failure),
    requestPath: input.requestPath,
    requestPayload: input.requestPayload,
    responsePayload: input.responsePayload,
    rawRequest: input.rawRequest,
    rawResponse: input.rawResponse,
    rawStream: input.rawStream,
    startedAtMs: input.startedAtMs,
    completedAtMs: input.completedAtMs,
    correlation: input.correlation
  });
}

function resolveCompatUpstreamRequest(input: {
  compatMode: boolean;
  provider: string;
  model: string;
  proxiedPath: string;
  payload: unknown;
  strictUpstreamPassthrough: boolean;
}): {
  provider: string;
  model: string;
  proxiedPath: string;
  payload: unknown;
  strictUpstreamPassthrough: boolean;
  translated: boolean;
  compatTranslation?: CompatTranslationMeta;
} {
  const { compatMode, provider, model, proxiedPath, payload, strictUpstreamPassthrough } = input;
  if (!compatMode || canonicalizeProvider(provider) !== 'openai') {
    return {
      provider,
      model,
      proxiedPath,
      payload,
      strictUpstreamPassthrough,
      translated: false,
      compatTranslation: undefined
    };
  }

  const parsed = parseRelativeProxyUrl(proxiedPath);
  if (parsed.pathname !== '/v1/messages') {
    return {
      provider,
      model,
      proxiedPath,
      payload,
      strictUpstreamPassthrough,
      translated: false,
      compatTranslation: undefined
    };
  }

  const translatedPayload = anthropicToOpenAi(payload);
  const translatedModel = typeof translatedPayload.model === 'string' && translatedPayload.model.trim().length > 0
    ? translatedPayload.model.trim()
    : model;
  const translatedPath = `/v1/responses${parsed.search}`;

  return {
    provider,
    model: translatedModel,
    proxiedPath: translatedPath,
    payload: translatedPayload,
    strictUpstreamPassthrough: false,
    translated: true,
    compatTranslation: {
      translated: true,
      originalProvider: 'anthropic',
      originalModel: model,
      originalPath: proxiedPath,
      translatedPath,
      translatedModel,
      strategy: 'anthropic_messages_to_openai_responses'
    }
  };
}

function resolveTokenModeTargetUrl(input: {
  provider: string;
  credential: TokenCredential;
  proxiedPath: string;
}): URL {
  const { provider, credential, proxiedPath } = input;
  if (isOpenAiOauthToken(credential, provider)) {
    const parsed = parseRelativeProxyUrl(proxiedPath);
    const nextPath = parsed.pathname === '/v1/responses'
      ? '/backend-api/codex/responses'
      : parsed.pathname;
    return new URL(`${nextPath}${parsed.search}`, 'https://chatgpt.com');
  }

  return new URL(proxiedPath, upstreamBaseUrl(provider));
}

function createClaudeCodeIdentitySystemBlock(): Record<string, unknown> {
  return {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY_SYSTEM_TEXT,
    cache_control: { type: 'ephemeral' }
  };
}

function hasClaudeCodeIdentitySystemBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).type === 'text'
    && (value as Record<string, unknown>).text === CLAUDE_CODE_IDENTITY_SYSTEM_TEXT;
}

function normalizeAnthropicOauthMessagesPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  const system = normalized.system;

  if (Array.isArray(system)) {
    if (system.some(hasClaudeCodeIdentitySystemBlock)) {
      return normalized;
    }
    normalized.system = [createClaudeCodeIdentitySystemBlock(), ...system];
    return normalized;
  }

  if (typeof system === 'string') {
    if (system.trimStart().startsWith(CLAUDE_CODE_IDENTITY_SYSTEM_TEXT)) {
      return normalized;
    }
    normalized.system = [
      createClaudeCodeIdentitySystemBlock(),
      { type: 'text', text: system }
    ];
    return normalized;
  }

  if (system == null) {
    normalized.system = [createClaudeCodeIdentitySystemBlock()];
  }

  return normalized;
}

function normalizeTokenModeUpstreamPayload(input: {
  provider: string;
  credential: TokenCredential;
  proxiedPath: string;
  payload: unknown;
  streaming?: boolean;
}): unknown {
  const { provider, credential, proxiedPath, payload, streaming } = input;
  const parsed = parseRelativeProxyUrl(proxiedPath);
  if (isAnthropicOauthToken(credential, provider)) {
    if (parsed.pathname !== '/v1/messages') return payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    return normalizeAnthropicOauthMessagesPayload(payload as Record<string, unknown>);
  }
  if (!isOpenAiOauthToken(credential, provider)) return payload;
  if (parsed.pathname !== '/v1/responses') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const normalized = { ...(payload as Record<string, unknown>) };
  // ChatGPT Codex backend rejects OpenAI token-limit params on this path.
  delete normalized.max_output_tokens;
  delete normalized.max_tokens;
  if (typeof normalized.instructions !== 'string' || normalized.instructions.trim().length === 0) {
    normalized.instructions = 'You are a helpful assistant.';
  }
  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
      const record = tool as Record<string, unknown>;
      const nested = record.function;
      if (record.type !== 'function' || !nested || typeof nested !== 'object' || Array.isArray(nested)) {
        return tool;
      }
      return {
        type: 'function',
        ...(nested as Record<string, unknown>)
      };
    });
  }
  if (normalized.tool_choice && typeof normalized.tool_choice === 'object' && !Array.isArray(normalized.tool_choice)) {
    const toolChoice = normalized.tool_choice as Record<string, unknown>;
    const nested = toolChoice.function;
    if (toolChoice.type === 'function' && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      normalized.tool_choice = {
        type: 'function',
        ...(nested as Record<string, unknown>)
      };
    }
  }

  return {
    ...normalized,
    // Codex ChatGPT backend rejects persisted Responses requests.
    store: false,
    // Codex ChatGPT backend currently requires streaming on this path.
    stream: true
  };
}

function extractLastTokenCount(raw: string, field: 'input_tokens' | 'output_tokens'): number | null {
  const regex = new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'g');
  let found: number | null = null;
  for (const match of raw.matchAll(regex)) {
    found = Number(match[1]);
  }
  return found;
}

function extractAnthropicTextContent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const content = (data as any).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && typeof item === 'object' && item.type === 'text')
    .map((item) => String(item.text ?? ''))
    .join('');
}

function normalizeSyntheticContentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = (message as any).content;
  if (Array.isArray(content)) {
    return content.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>;
  }
  const fallbackText = extractAnthropicTextContent(message);
  if (fallbackText.length > 0) {
    return [{ type: 'text', text: fallbackText }];
  }
  return [];
}

function looksLikeSsePayload(raw: string): boolean {
  const trimmed = raw.trimStart();
  return trimmed.startsWith('data:')
    || trimmed.startsWith('event:')
    || trimmed.startsWith(':')
    || trimmed.includes('\n\ndata:')
    || trimmed.includes('\n\nevent:');
}

async function peekResponseBodyPrefix(response: globalThis.Response, maxBytes = 512): Promise<string> {
  try {
    const body = response.clone().body;
    if (!body) return '';
    const reader = body.getReader();
    try {
      const { value, done } = await reader.read();
      if (done || !value) return '';
      const prefix = value instanceof Uint8Array ? value : new Uint8Array(value);
      return new TextDecoder().decode(prefix.slice(0, maxBytes));
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  } catch {
    return '';
  }
}

async function readUpstreamBody(input: {
  upstreamResponse: globalThis.Response;
  contentType: string;
}): Promise<{
  rawText: string;
  data: unknown;
  looksLikeSse: boolean;
}> {
  const { upstreamResponse, contentType } = input;
  const rawText = await upstreamResponse.text().catch(() => '');
  const sseLike = looksLikeSsePayload(rawText);
  if (!contentType.includes('application/json')) {
    return {
      rawText,
      data: rawText,
      looksLikeSse: sseLike
    };
  }
  if (rawText.trim().length === 0) {
    return {
      rawText,
      data: {},
      looksLikeSse: false
    };
  }
  try {
    return {
      rawText,
      data: JSON.parse(rawText),
      looksLikeSse: sseLike
    };
  } catch {
    return {
      rawText,
      data: {},
      looksLikeSse: sseLike
    };
  }
}

function shouldTraceAnthropicFirstPass(input: {
  provider: string;
  proxiedPath: string;
  credential: TokenCredential;
  attemptNo: number;
  compat: CompatNormalizationState;
}): boolean {
  return process.env.INNIES_ANTHROPIC_FIRST_PASS_TRACE === '1'
    && input.provider === 'anthropic'
    && input.proxiedPath === '/v1/messages'
    && input.attemptNo === 1
    && isAnthropicOauthToken(input.credential, input.provider)
    && !input.compat.blockedRetryApplied
    && !input.compat.oauthRetryApplied;
}

function logAnthropicFirstPassTraceRequest(input: {
  requestId: string;
  attemptNo: number;
  provider: string;
  proxiedPath: string;
  targetUrl: URL;
  credential: TokenCredential;
  headers: Record<string, string>;
  body: string;
  streaming: boolean;
}): void {
  const headers = sanitizeTraceHeaders(input.headers);
  const capture = persistCompatTraceBody({
    requestId: input.requestId,
    phase: 'upstream-request',
    attemptNo: input.attemptNo,
    body: input.body,
    metadata: {
      provider: input.provider,
      proxied_path: input.proxiedPath,
      target_url: input.targetUrl.toString(),
      credential_id: input.credential.id,
      credential_label: input.credential.debugLabel ?? null,
      stream: input.streaming,
      headers
    }
  });

  console.info('[anthropic-first-pass-trace-request]', {
    request_id: input.requestId,
    attempt_no: input.attemptNo,
    provider: input.provider,
    proxied_path: input.proxiedPath,
    target_url: input.targetUrl.toString(),
    credential_id: input.credential.id,
    credential_label: input.credential.debugLabel ?? null,
    stream: input.streaming,
    headers,
    body_sha256: capture?.bodySha256 ?? sha256Hex(input.body),
    body_bytes: capture?.bodyBytes ?? Buffer.byteLength(input.body, 'utf8'),
    body_path: capture?.bodyPath ?? null,
    meta_path: capture?.metaPath ?? null
  });
}

async function logAnthropicFirstPassTraceResponse(input: {
  requestId: string;
  attemptNo: number;
  provider: string;
  proxiedPath: string;
  targetUrl: URL;
  credential: TokenCredential;
  upstreamResponse: globalThis.Response;
}): Promise<void> {
  const contentType = input.upstreamResponse.headers.get('content-type') ?? 'application/octet-stream';
  const responseHeaders = collectTraceResponseHeaders(input.upstreamResponse.headers);
  let parsedBody: unknown = undefined;
  let bodySha256: string | null = null;
  let bodyBytes: number | null = null;

  if (input.upstreamResponse.status >= 400 || contentType.includes('application/json')) {
    const tracedBody = await readUpstreamBody({
      upstreamResponse: input.upstreamResponse.clone(),
      contentType
    });
    parsedBody = tracedBody.data;
    bodySha256 = sha256Hex(tracedBody.rawText);
    bodyBytes = Buffer.byteLength(tracedBody.rawText, 'utf8');
  }

  console.info('[anthropic-first-pass-trace-response]', {
    request_id: input.requestId,
    attempt_no: input.attemptNo,
    provider: input.provider,
    proxied_path: input.proxiedPath,
    target_url: input.targetUrl.toString(),
    credential_id: input.credential.id,
    credential_label: input.credential.debugLabel ?? null,
    upstream_status: input.upstreamResponse.status,
    upstream_content_type: contentType,
    response_headers: responseHeaders,
    body_sha256: bodySha256,
    body_bytes: bodyBytes,
    parsed_body: parsedBody
  });
}

function summarizeSyntheticContentBlocks(message: Record<string, unknown>): { count: number; types: string } {
  const blocks = normalizeSyntheticContentBlocks(message);
  const uniqueTypes = new Set<string>();
  for (const block of blocks) {
    const type = typeof block.type === 'string' ? block.type : 'unknown';
    uniqueTypes.add(type);
  }
  return {
    count: blocks.length,
    types: Array.from(uniqueTypes).join(',')
  };
}

function resolveSyntheticUsageFromPayload(data: unknown): {
  inputTokens: number;
  outputTokens: number;
  usageUnits: number;
  meteringSource: MeteringSource;
} {
  const inputTokens = Number((data as any)?.usage?.input_tokens ?? 0);
  const outputTokens = Number((data as any)?.usage?.output_tokens ?? 0);
  const usageUnits = Math.max(0, inputTokens + outputTokens);
  if (usageUnits > 0) {
    return { inputTokens, outputTokens, usageUnits, meteringSource: 'payload_usage' };
  }
  return {
    inputTokens: 0,
    outputTokens: 0,
    usageUnits: 1,
    meteringSource: 'stream_estimate'
  };
}

function buildSyntheticAnthropicSse(data: unknown, model: string): string {
  const message = data && typeof data === 'object' ? (data as any) : {};
  const id = String(message.id ?? `msg_${Date.now()}`);
  const blocks = normalizeSyntheticContentBlocks(message);
  const inputTokens = Number(message?.usage?.input_tokens ?? 0);
  const outputTokens = Number(message?.usage?.output_tokens ?? 0);
  const stopReason = String(message.stop_reason ?? 'end_turn');

  const events = [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 }
      }
    })}\n\n`
  ];

  blocks.forEach((block, index) => {
    const blockType = typeof block.type === 'string' ? block.type : 'unknown';
    if (blockType === 'text') {
      const text = String((block as any).text ?? '');
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' }
        })}\n\n`
      );
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text }
        })}\n\n`
      );
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index
        })}\n\n`
      );
      return;
    }

    if (blockType === 'tool_use') {
      const toolUseId = String((block as any).id ?? `tool_${index}`);
      const toolName = String((block as any).name ?? 'tool');
      const inputPayload = (block as any).input ?? {};
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} }
        })}\n\n`
      );
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputPayload) }
        })}\n\n`
      );
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index
        })}\n\n`
      );
      return;
    }

    if (blockType === 'thinking') {
      const thinking = String((block as any).thinking ?? '');
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' }
        })}\n\n`
      );
      if (thinking.length > 0) {
        events.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking }
          })}\n\n`
        );
      }
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index
        })}\n\n`
      );
      return;
    }

    events.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: block
      })}\n\n`
    );
    events.push(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index
      })}\n\n`
    );
  });

  events.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    })}\n\n`
  );
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return events.join('');
}

function extractAnthropicStreamErrorDetailsFromRecord(rawRecord: string): { errorType?: string; errorMessage?: string } {
  const trimmed = rawRecord.trim();
  if (trimmed.length === 0 || trimmed.startsWith(':')) return {};

  let explicitEvent: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('event:')) {
      explicitEvent = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return {};
  const rawData = dataLines.join('\n');
  if (rawData === '[DONE]') return {};

  let payload: unknown;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return {};
  }

  if (!payload || typeof payload !== 'object') return {};
  const payloadType = typeof (payload as any).type === 'string' ? (payload as any).type : undefined;
  if (payloadType !== 'error' && explicitEvent !== 'error') return {};
  return extractUpstreamErrorDetails(payload);
}

function extractAnthropicStreamErrorDetails(raw: string): { errorType?: string; errorMessage?: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  let remaining = normalized;
  let lastErrorDetails: { errorType?: string; errorMessage?: string } = {};

  let boundaryIndex = remaining.indexOf('\n\n');
  while (boundaryIndex >= 0) {
    const details = extractAnthropicStreamErrorDetailsFromRecord(remaining.slice(0, boundaryIndex));
    if (details.errorType || details.errorMessage) {
      lastErrorDetails = details;
    }
    remaining = remaining.slice(boundaryIndex + 2);
    boundaryIndex = remaining.indexOf('\n\n');
  }

  if (remaining.trim().length > 0) {
    const details = extractAnthropicStreamErrorDetailsFromRecord(remaining);
    if (details.errorType || details.errorMessage) {
      lastErrorDetails = details;
    }
  }

  return lastErrorDetails;
}

function buildSyntheticAnthropicStreamFailureSse(input: {
  id?: string;
  model: string;
  message: string;
}): string {
  return `event: error\ndata: ${JSON.stringify({
    type: 'error',
    error: {
      type: 'api_error',
      message: input.message
    }
  })}\n\n`;
}

function hasTerminalAnthropicStreamEvent(raw: string): boolean {
  const normalized = raw.toLowerCase();
  return normalized.includes('event: message_stop')
    || normalized.includes('"type":"message_stop"')
    || normalized.includes('event: error')
    || normalized.includes('"type":"error"');
}

function isDownstreamClientDisconnect(res: Response, error: unknown): boolean {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : null;
  if ((res as any).destroyed || (res as any).writableEnded) return true;
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'DOWNSTREAM_CLOSED';
}

type StreamTerminalStatus = 'completed' | 'incomplete' | 'failed' | 'missing';
type StreamTerminalErrorMetadata = {
  streamTerminalErrorType: string | null;
  streamTerminalErrorCode: string | null;
  streamTerminalErrorMessage: string | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sanitizeStreamTerminalErrorValue(value: unknown, maxChars = 280): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, maxChars);
}

function parseSseObjectPayloads(raw: string): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];
  for (const chunk of raw.split(/\n\n+/)) {
    const dataLines = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n').trim();
    if (joined.length === 0 || joined === '[DONE]') continue;
    try {
      const parsed = JSON.parse(joined);
      const record = readRecord(parsed);
      if (record) {
        payloads.push(record);
      }
    } catch {
      continue;
    }
  }
  return payloads;
}

function readStreamOrdinal(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function cloneSseRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function createAnthropicContentBlockFromDelta(delta: Record<string, unknown>): Record<string, unknown> {
  switch (delta.type) {
    case 'text_delta':
      return { type: 'text', text: '' };
    case 'input_json_delta':
      return { type: 'tool_use', input: {} };
    case 'thinking_delta':
      return { type: 'thinking', thinking: '' };
    case 'signature_delta':
      return { type: 'thinking', thinking: '', signature: '' };
    default:
      return {};
  }
}

function parseJsonFragment(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function applyAnthropicContentDelta(input: {
  block: Record<string, unknown>;
  delta: Record<string, unknown>;
  index: number;
  toolInputFragments: Map<number, string>;
}): void {
  const { block, delta, index, toolInputFragments } = input;
  switch (delta.type) {
    case 'text_delta':
      block.type = 'text';
      block.text = `${typeof block.text === 'string' ? block.text : ''}${typeof delta.text === 'string' ? delta.text : ''}`;
      break;
    case 'input_json_delta': {
      block.type = 'tool_use';
      const nextFragment = `${toolInputFragments.get(index) ?? ''}${typeof delta.partial_json === 'string' ? delta.partial_json : ''}`;
      toolInputFragments.set(index, nextFragment);
      block.input = parseJsonFragment(nextFragment);
      break;
    }
    case 'thinking_delta':
      block.type = 'thinking';
      block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${typeof delta.thinking === 'string' ? delta.thinking : ''}`;
      break;
    case 'signature_delta':
      if (typeof delta.signature === 'string') {
        block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
      }
      break;
    default:
      break;
  }
}

function extractAnthropicMessageFromSse(raw: string): Record<string, unknown> | null {
  const payloads = parseSseObjectPayloads(raw);
  let message: Record<string, unknown> | null = null;
  const contentBlocks = new Map<number, Record<string, unknown>>();
  const toolInputFragments = new Map<number, string>();

  for (const payload of payloads) {
    switch (payload.type) {
      case 'message_start': {
        const startedMessage = readRecord(payload.message);
        if (!startedMessage) break;
        message = cloneSseRecord(startedMessage);
        const startedContent = Array.isArray(startedMessage.content) ? startedMessage.content : [];
        for (const [index, block] of startedContent.entries()) {
          const record = readRecord(block);
          if (!record) continue;
          contentBlocks.set(index, cloneSseRecord(record));
        }
        break;
      }
      case 'content_block_start': {
        const index = readStreamOrdinal(payload.index);
        const block = readRecord(payload.content_block);
        if (index === null || !block) break;
        contentBlocks.set(index, cloneSseRecord(block));
        break;
      }
      case 'content_block_delta': {
        const index = readStreamOrdinal(payload.index);
        const delta = readRecord(payload.delta);
        if (index === null || !delta) break;
        const block = contentBlocks.get(index) ?? createAnthropicContentBlockFromDelta(delta);
        applyAnthropicContentDelta({
          block,
          delta,
          index,
          toolInputFragments
        });
        contentBlocks.set(index, block);
        break;
      }
      case 'message_delta': {
        if (!message) {
          message = { role: 'assistant', content: [] };
        }
        const delta = readRecord(payload.delta);
        if (delta) {
          if (Object.prototype.hasOwnProperty.call(delta, 'stop_reason')) {
            message.stop_reason = delta.stop_reason ?? null;
          }
          if (Object.prototype.hasOwnProperty.call(delta, 'stop_sequence')) {
            message.stop_sequence = delta.stop_sequence ?? null;
          }
        }
        const usage = readRecord(payload.usage);
        if (usage) {
          message.usage = {
            ...(readRecord(message.usage) ?? {}),
            ...usage
          };
        }
        break;
      }
      default:
        break;
    }
  }

  if (!message && contentBlocks.size === 0) {
    return null;
  }

  const content = Array.from(contentBlocks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, block]) => {
      const nextBlock = cloneSseRecord(block);
      if (nextBlock.type === 'tool_use' && toolInputFragments.has(index)) {
        nextBlock.input = parseJsonFragment(toolInputFragments.get(index) ?? '');
      }
      return nextBlock;
    });

  const nextMessage = message ?? { role: 'assistant' };
  if (content.length > 0) {
    nextMessage.content = content;
  } else if (!Array.isArray(nextMessage.content)) {
    nextMessage.content = [];
  }

  return nextMessage;
}

function extractArchiveResponsePayloadFromStream(input: {
  rawStream: string;
  downstreamUsesAnthropicSse: boolean;
}): unknown | null {
  return input.downstreamUsesAnthropicSse
    ? extractAnthropicMessageFromSse(input.rawStream)
    : extractTerminalOpenAiResponseFromSse(input.rawStream);
}

function extractOpenAiResponsesStreamTerminalError(raw: string): StreamTerminalErrorMetadata | null {
  const payloads = parseSseObjectPayloads(raw);
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (payload.type !== 'response.failed') continue;
    const response = readRecord(payload.response);
    const error = readRecord(response?.error);
    const type = sanitizeStreamTerminalErrorValue(error?.type);
    const code = sanitizeStreamTerminalErrorValue(error?.code);
    const message = sanitizeStreamTerminalErrorValue(error?.message);
    if (type || code || message) {
      return {
        streamTerminalErrorType: type,
        streamTerminalErrorCode: code,
        streamTerminalErrorMessage: message
      };
    }
  }
  return null;
}

function extractAnthropicStreamTerminalError(raw: string): StreamTerminalErrorMetadata | null {
  const payloads = parseSseObjectPayloads(raw);
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (payload.type !== 'error') continue;
    const error = readRecord(payload.error);
    const type = sanitizeStreamTerminalErrorValue(error?.type);
    const code = sanitizeStreamTerminalErrorValue(error?.code);
    const message = sanitizeStreamTerminalErrorValue(error?.message);
    if (type || code || message) {
      return {
        streamTerminalErrorType: type,
        streamTerminalErrorCode: code,
        streamTerminalErrorMessage: message
      };
    }
  }
  return null;
}

function extractStreamTerminalErrorMetadata(input: {
  downstreamUsesAnthropicSse: boolean;
  raw: string;
}): StreamTerminalErrorMetadata | null {
  return input.downstreamUsesAnthropicSse
    ? extractAnthropicStreamTerminalError(input.raw)
    : extractOpenAiResponsesStreamTerminalError(input.raw);
}

function resolveOpenAiResponsesStreamTerminalStatus(raw: string): StreamTerminalStatus {
  const normalized = raw.toLowerCase();
  if (normalized.includes('"type":"response.failed"')) return 'failed';
  if (normalized.includes('"type":"response.incomplete"')) return 'incomplete';
  if (normalized.includes('"type":"response.completed"') || normalized.includes('data: [done]')) {
    return 'completed';
  }
  return 'missing';
}

function resolveAnthropicStreamTerminalStatus(raw: string): StreamTerminalStatus {
  const normalized = raw.toLowerCase();
  if (raw.includes('[Translation error:')) return 'failed';
  if (normalized.includes('event: error') || normalized.includes('"type":"error"')) return 'failed';
  return hasTerminalAnthropicStreamEvent(raw) ? 'completed' : 'missing';
}

function createDownstreamClosedError(): Error {
  const error = new Error('downstream closed');
  (error as any).code = 'DOWNSTREAM_CLOSED';
  return error;
}

function buildSyntheticPassthroughFailureSse(input: {
  downstreamUsesAnthropicSse: boolean;
  id: string;
  model: string;
  anthropicModel: string;
}): string {
  if (input.downstreamUsesAnthropicSse) {
    return buildSyntheticAnthropicStreamFailureSse({
      id: input.id,
      model: input.anthropicModel,
      message: 'upstream stream ended before completion'
    });
  }
  return buildSyntheticOpenAiStreamFailureSse({
    id: input.id,
    model: input.model,
    message: 'Innies upstream stream ended before completion'
  });
}

async function waitForResponseDrainOrClose(res: Response): Promise<void> {
  const writable = res as any;
  if (writable.destroyed || writable.writableEnded) {
    throw createDownstreamClosedError();
  }
  if (typeof writable.once !== 'function') {
    return;
  }
  const removeListener = typeof writable.off === 'function'
    ? (event: string, handler: (...args: any[]) => void) => writable.off(event, handler)
    : (typeof writable.removeListener === 'function'
      ? (event: string, handler: (...args: any[]) => void) => writable.removeListener(event, handler)
      : null);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      removeListener?.('drain', onDrain);
      removeListener?.('close', onClose);
      removeListener?.('finish', onFinish);
      removeListener?.('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(createDownstreamClosedError());
    };
    const onFinish = () => {
      cleanup();
      reject(createDownstreamClosedError());
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };

    writable.once('drain', onDrain);
    writable.once('close', onClose);
    writable.once('finish', onFinish);
    writable.once('error', onError);
  });

  if (writable.destroyed || writable.writableEnded) {
    throw createDownstreamClosedError();
  }
}

async function writeReadableToResponse(input: {
  source: NodeJS.ReadableStream;
  res: Response;
  onChunk: (buffer: Buffer) => void;
  onDownstreamWrite: () => void;
}): Promise<void> {
  for await (const chunk of input.source as AsyncIterable<Buffer | Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    input.onChunk(buffer);

    if ((input.res as any).destroyed || (input.res as any).writableEnded) {
      throw createDownstreamClosedError();
    }

    input.onDownstreamWrite();
    const writeResult = (input.res as any).write(buffer);
    if (typeof (input.res as any).flush === 'function') {
      (input.res as any).flush();
    }
    if (writeResult === false && typeof (input.res as any).once === 'function') {
      await waitForResponseDrainOrClose(input.res);
    }
  }
}

function sendProxyReplayNotSupported(res: Response, requestId: string): void {
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-idempotent-replay', 'true');
  res.status(409).json({
    code: 'proxy_replay_not_supported',
    message: 'Proxy requests are metadata-only idempotent in C1. Retry with a new Idempotency-Key.'
  });
}

function generateCompatIdempotencyKey(requestId: string): string {
  const raw = `compat_${requestId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return raw.padEnd(32, '0').slice(0, 128);
}

async function commitProxyMetadataIdempotency(
  session: IdempotencySession,
  responseRef: string,
  digestPayload: unknown
): Promise<void> {
  await runtime.services.idempotency.commit(session, {
    responseCode: 409,
    responseBody: null,
    responseDigest: sha256Hex(stableJson(digestPayload)),
    responseRef
  });
}

async function executeTokenModeNonStreaming(input: {
  requestId: string;
  orgId: string;
  apiKeyId: string;
  buyerKeyLabel?: string | null;
  correlation: OpenClawCorrelation;
  provider: string;
  model: string;
  payload: unknown;
  proxiedPath: string;
  archiveRequestPayload: unknown;
  archiveRequestPath: string;
  anthropicVersion: string;
  anthropicBeta?: string;
  startedAt: number;
  strictUpstreamPassthrough?: boolean;
  providerPreference?: ProviderPreferenceMeta;
  compatTranslation?: CompatTranslationMeta;
  allowCompatTerminalErrorResponse?: boolean;
  rescueTracker?: RescueTracker;
}): Promise<ProxyRouteResult> {
  const {
    requestId,
    orgId,
    apiKeyId,
    buyerKeyLabel,
    correlation,
    provider,
    model,
    payload,
    proxiedPath,
    archiveRequestPayload,
    archiveRequestPath,
    anthropicVersion,
    anthropicBeta,
    startedAt,
    strictUpstreamPassthrough,
    providerPreference,
    compatTranslation,
    allowCompatTerminalErrorResponse,
    rescueTracker
  } = input;
  const {
    credentials,
    providerUsageRouteMeta,
    providerUsageExcludedReasonCounts,
    providerUsageExcludedRouteMeta
  } = await resolveEligibleTokenCredentialsWithAnthropicStaleRecovery({
    orgId,
    provider,
    requestId,
    buyerKeyLabel,
    model,
    allowCompatProviderUsageFailOpen: Boolean(strictUpstreamPassthrough || compatTranslation)
  });
  if (credentials.length === 0) {
    throw new AppError('capacity_unavailable', 429, 'No eligible token credentials available', {
      provider,
      model,
      providerUsageExcludedReasonCounts: Object.keys(providerUsageExcludedReasonCounts).length > 0
        ? providerUsageExcludedReasonCounts
        : undefined,
      providerUsageExcludedRouteMeta: Object.keys(providerUsageExcludedRouteMeta).length > 0
        ? providerUsageExcludedRouteMeta
        : undefined
    });
  }

  let attemptNo = 0;
  let sawAuthFailure = false;
  let lastAuthStatus: number | null = null;
  let lastAuthFailure: { attemptNo: number; credentialId: string; credentialLabel?: string | null; status: number; errorType?: string; errorMessage?: string } | null = null;
  let terminalCompatError: ReturnType<typeof mapOpenAiErrorToAnthropic> | null = null;
  let terminalCompatCredentialId: string | null = null;
  let terminalCompatAttemptNo = 0;
  let terminalNative400Result: ProxyRouteResult | null = null;
  let sawNonAuthNon400Failure = false;
  let sawRateLimitFailure = false;
  let lastRetryableFailure: AttemptFailure | null = null;
  const initialSameProviderRetryLimit = selectSameProviderRetryCredentials(credentials).length;
  let allowExpandedSameProviderRetry = false;
  for (let credentialIndex = 0; credentialIndex < credentials.length; credentialIndex += 1) {
    if (credentialIndex >= initialSameProviderRetryLimit && !allowExpandedSameProviderRetry) break;
    attemptNo += 1;
    let credential = credentials[credentialIndex]!;
    let refreshed = false;
    let compat = createCompatNormalizationState(payload, anthropicBeta);
    allowExpandedSameProviderRetry = false;

    while (true) {
      const targetUrl = resolveTokenModeTargetUrl({
        provider,
        credential,
        proxiedPath
      });
      const timeoutMs = upstreamTimeoutMs();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const dispatchStartedAt = Date.now();
      const upstreamPayload = normalizeTokenModeUpstreamPayload({
        provider,
        credential,
        proxiedPath,
        payload: compat.payload ?? {},
        streaming: false
      });
      const upstreamHeaders = buildTokenModeUpstreamHeaders({
        requestId,
        anthropicVersion,
        anthropicBeta: compat.anthropicBeta,
        provider,
        credential,
        skipOauthDefaultBetas: compat.blockedRetryApplied
      });
      const upstreamBody = JSON.stringify(upstreamPayload);
      const traceAnthropicFirstPass = shouldTraceAnthropicFirstPass({
        provider,
        proxiedPath,
        credential,
        attemptNo,
        compat
      });
      if (traceAnthropicFirstPass) {
        logAnthropicFirstPassTraceRequest({
          requestId,
          attemptNo,
          provider,
          proxiedPath,
          targetUrl,
          credential,
          headers: upstreamHeaders,
          body: upstreamBody,
          streaming: false
        });
      }

      const logAttemptFailure = async (
        failure: AttemptFailure,
        ttfb?: number | null,
        options?: { archive?: boolean }
      ) => {
        await runtime.repos.routingEvents.insert({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          provider,
          model,
          streaming: false,
          routeDecision: buildTokenRouteDecision(
            credential,
            correlation,
            providerPreference,
            compatTranslation,
            providerUsageRouteMeta.get(credential.id),
            buildRescueRouteDecisionMeta(rescueTracker, {
              provider,
              credential
            })
          ),
          upstreamStatus: failure.statusCode,
          errorCode: inferErrorCode(failure),
          latencyMs: Date.now() - startedAt,
          ttfbMs: ttfb ?? null
        });
        if (options?.archive !== false) {
          await archiveFailedProxyAttempt({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            routeKind: 'token_credential',
            tokenCredentialId: credential.id,
            provider,
            model,
            streaming: false,
            requestPath: archiveRequestPath,
            requestPayload: archiveRequestPayload,
            startedAtMs: startedAt,
            correlation,
            failure
          });
        }
      };

      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: upstreamBody,
        signal: controller.signal
        })
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : 'network error';
          await logAttemptFailure({ kind: 'network', message });
          return null;
        })
        .finally(() => clearTimeout(timer));

      if (!upstreamResponse) {
        const failure = { kind: 'network', message: 'network error' } satisfies AttemptFailure;
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure
        });
        sawNonAuthNon400Failure = true;
        lastRetryableFailure = failure;
        allowExpandedSameProviderRetry = shouldExpandSameProviderRetryBudget(failure);
        break;
      }

      const status = upstreamResponse.status;
      const upstreamHeadersAt = Date.now();
      const ttfbMs = Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt));
      if (traceAnthropicFirstPass) {
        await logAnthropicFirstPassTraceResponse({
          requestId,
          attemptNo,
          provider,
          proxiedPath,
          targetUrl,
          credential,
          upstreamResponse
        });
      }
      if (status === 403 && strictUpstreamPassthrough) {
        const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
        const data = contentType.includes('application/json')
          ? await upstreamResponse.json().catch(() => ({}))
          : await upstreamResponse.text();
        const blocked = isUpstreamBlockedResponse(status, data);
        if (blocked && !compat.blockedRetryApplied) {
          await recordTokenCredentialOutcome({
            credential,
            requestId,
            attemptNo,
            provider,
            model,
            upstreamStatus: status
          });
          logRetryAudit({
            orgId,
            provider,
            model,
            requestId,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
          attemptNo,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          upstreamStatus: status,
          retryReason: 'blocked_403_compat_retry'
        });
          compat = applyCompatNormalization({
            requestId,
            attemptNo,
            credentialId: credential.id,
            provider,
            credential,
            state: compat,
            reason: 'retry_blocked_403'
          });
          continue;
        }
        if (blocked) {
          await recordTokenCredentialOutcome({
            credential,
            requestId,
            attemptNo,
            provider,
            model,
            upstreamStatus: status
          });
          const { errorType, errorMessage } = extractUpstreamErrorDetails(data);
          await runtime.repos.routingEvents.insert({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            sellerKeyId: undefined,
            provider,
            model,
            streaming: false,
            routeDecision: buildTokenRouteDecision(
              credential,
              correlation,
              providerPreference,
              compatTranslation,
              providerUsageRouteMeta.get(credential.id)
            ),
            upstreamStatus: status,
            errorCode: 'upstream_403_blocked_passthrough',
            latencyMs: Date.now() - startedAt,
            ttfbMs
          });
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType,
            errorMessage
          });

          return {
            requestId,
            keyId: credential.id,
            attemptNo,
            upstreamStatus: status,
            usageUnits: 0,
            contentType,
            data,
            routeKind: 'token_credential',
            alreadyRecorded: true
          };
        }
      }

      if (status === 401 || (status === 403 && !compatTranslation)) {
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
        let statusErrorType: string | undefined;
        let statusErrorMessage: string | undefined;
        let statusData: unknown = null;
        if (strictUpstreamPassthrough || compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          statusData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
          const details = extractUpstreamErrorDetails(statusData);
          statusErrorType = details.errorType;
          statusErrorMessage = details.errorMessage;
          if (compatTranslation) {
            terminalCompatError = mapOpenAiErrorToAnthropic(status, statusData);
            terminalCompatCredentialId = credential.id;
            terminalCompatAttemptNo = attemptNo;
          }
        }
        if (shouldRetryWithOauthSafeCompatPayload({
          status,
          strictUpstreamPassthrough,
          provider,
          credential,
          alreadyRetried: compat.oauthRetryApplied,
          payload: compat.payload,
          anthropicBeta: compat.anthropicBeta,
          errorType: statusErrorType,
          errorMessage: statusErrorMessage
        })) {
          logRetryAudit({
            orgId,
            provider,
            model,
            requestId,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            attemptNo,
            credentialId: credential.id,
            credentialLabel: credential.debugLabel,
            upstreamStatus: status,
            retryReason: 'oauth_401_compat_retry'
          });
          compat = applyCompatNormalization({
            requestId,
            attemptNo,
            credentialId: credential.id,
            provider,
            credential,
            state: compat,
            reason: 'retry_oauth_401'
          });
          continue;
        }
        if (!refreshed) {
          const next = await attemptTokenCredentialRefresh(runtime.repos.tokenCredentials, credential);
          refreshed = true;
          if (next) {
            logRetryAudit({
              orgId,
              provider,
              model,
              requestId,
              openclawRunId: correlation.openclawRunId,
              openclawSessionId: correlation.openclawSessionId,
              attemptNo,
              credentialId: credential.id,
              credentialLabel: credential.debugLabel,
              upstreamStatus: status,
              retryReason: 'credential_refresh_retry'
            });
            credential = next;
            continue;
          }
        }
        sawAuthFailure = true;
        lastAuthStatus = status;
        lastAuthFailure = {
          attemptNo,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          status,
          errorType: statusErrorType,
          errorMessage: statusErrorMessage
        };
        await logAttemptFailure({ kind: 'auth', statusCode: status, message: 'token auth failed' }, ttfbMs);
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { kind: 'auth', statusCode: status, message: 'token auth failed' }
        });
        if (strictUpstreamPassthrough) {
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType: statusErrorType,
            errorMessage: statusErrorMessage
          });
        }
        break;
      }

      if (status === 429) {
        const rateLimitData = await readUpstreamErrorPayload(upstreamResponse);
        if (compatTranslation) {
          terminalCompatError = mapOpenAiErrorToAnthropic(status, rateLimitData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        }
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
        await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' }, ttfbMs);
        logRetryAudit({
          orgId,
          provider,
          model,
          requestId,
          openclawRunId: correlation.openclawRunId,
          openclawSessionId: correlation.openclawSessionId,
          attemptNo,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          upstreamStatus: status,
          retryReason: 'rate_limited_backoff'
        });
        const backoffMs = 200 * (2 ** (attemptNo - 1)) + Math.floor(Math.random() * 100);
        await sleep(backoffMs);
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { kind: 'rate_limited', statusCode: 429, message: 'rate limited' }
        });
        sawRateLimitFailure = true;
        sawNonAuthNon400Failure = true;
        break;
      }

      if (status >= 500) {
        const failure = { kind: 'server_error', statusCode: status, message: 'upstream server error' } satisfies AttemptFailure;
        if (strictUpstreamPassthrough) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const data = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();

          await runtime.repos.routingEvents.insert({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            sellerKeyId: undefined,
            provider,
            model,
            streaming: false,
            routeDecision: buildTokenRouteDecision(
              credential,
              correlation,
              providerPreference,
              compatTranslation,
              providerUsageRouteMeta.get(credential.id)
            ),
            upstreamStatus: status,
            errorCode: 'upstream_5xx_passthrough',
            latencyMs: Date.now() - startedAt,
            ttfbMs
          });

          return {
            requestId,
            keyId: credential.id,
            attemptNo,
            upstreamStatus: status,
            usageUnits: 0,
            contentType,
            data,
            routeKind: 'token_credential',
            alreadyRecorded: true
          };
        }

        if (compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const upstreamErrorData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
          terminalCompatError = mapOpenAiErrorToAnthropic(status, upstreamErrorData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        }

        await logAttemptFailure(failure, ttfbMs);
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure
        });
        sawNonAuthNon400Failure = true;
        lastRetryableFailure = failure;
        allowExpandedSameProviderRetry = shouldExpandSameProviderRetryBudget(failure);
        break;
      }

      if (status === 400) {
        const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
        const upstreamErrorData = await readUpstreamErrorPayload(upstreamResponse);
        if (compatTranslation) {
          terminalCompatError = mapOpenAiErrorToAnthropic(status, upstreamErrorData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        } else if (allowCompatTerminalErrorResponse) {
          terminalNative400Result = {
            requestId,
            keyId: credential.id,
            attemptNo,
            upstreamStatus: status,
            usageUnits: 0,
            contentType,
            data: upstreamErrorData,
            routeKind: 'token_credential',
            alreadyRecorded: true
          };
        }
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
        if (strictUpstreamPassthrough) {
          const { errorType, errorMessage } = extractUpstreamErrorDetails(upstreamErrorData);
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType,
            errorMessage
          });
        }
        await logAttemptFailure({ statusCode: status, message: 'upstream provider rejected request' }, ttfbMs);
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { statusCode: status, message: 'upstream provider rejected request' }
        });
        break;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const { data: rawData, rawText, looksLikeSse } = await readUpstreamBody({
        upstreamResponse,
        contentType
      });
      const extractedSseResponse = status >= 200 && status < 300 && looksLikeSse
        ? extractTerminalOpenAiResponseFromSse(rawText)
        : null;
      const data = extractedSseResponse ?? rawData;
      const extractedStatus = typeof (extractedSseResponse as any)?.status === 'string'
        ? String((extractedSseResponse as any).status)
        : null;
      const extractedFailed = extractedStatus === 'failed';
      const effectiveStatus = extractedFailed ? 500 : status;
      // Map ALL error statuses on translated paths to Anthropic-shaped error envelopes.
      const downstreamMappedError = compatTranslation && (status >= 400 || extractedFailed)
        ? mapOpenAiErrorToAnthropic(effectiveStatus, data)
        : null;
      if (compatTranslation && (status >= 400 || extractedFailed)) {
        logCompatTranslatedUpstreamError({
          requestId,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          provider,
          model,
          translatedPath: compatTranslation.translatedPath,
          translatedModel: compatTranslation.translatedModel,
          upstreamStatus: effectiveStatus,
          upstreamContentType: contentType,
          upstreamError: data
        });
      }
      if (extractedFailed && !strictUpstreamPassthrough) {
        if (compatTranslation && downstreamMappedError) {
          terminalCompatError = downstreamMappedError;
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        }
        await logAttemptFailure({
          kind: 'upstream_failed_stream',
          statusCode: effectiveStatus,
          message: 'upstream responses stream reported failure'
        }, ttfbMs);
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: {
            kind: 'upstream_failed_stream',
            statusCode: effectiveStatus,
            message: 'upstream responses stream reported failure'
          }
        });
        sawNonAuthNon400Failure = true;
        break;
      }
      const downstreamData = compatTranslation && status >= 200 && status < 300 && !extractedFailed
        ? translateOpenAiToAnthropic({
          data,
          model: compatTranslation.originalModel
        })
        : (downstreamMappedError?.body ?? data);
      const downstreamContentType = compatTranslation || extractedSseResponse ? 'application/json' : contentType;
      if (strictUpstreamPassthrough && status >= 400) {
        const { errorType, errorMessage } = extractUpstreamErrorDetails(data);
        logCompatAudit({
          orgId,
          provider,
          model,
          requestId,
          credentialId: credential.id,
          attemptNo,
          upstreamStatus: status,
          openclawRunId: correlation.openclawRunId,
          openclawSessionId: correlation.openclawSessionId,
          errorType,
          errorMessage
        });
      }
      const inputTokens = Number((data as any)?.usage?.input_tokens ?? 0);
      const outputTokens = Number((data as any)?.usage?.output_tokens ?? 0);
      const usageUnits = Math.max(0, inputTokens + outputTokens);

      if (status >= 200 && status < 300 && !extractedFailed) {
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
      }

      await runtime.repos.routingEvents.insert({
        requestId,
        attemptNo,
        orgId,
        apiKeyId,
        sellerKeyId: undefined,
        provider,
        model,
        streaming: false,
        routeDecision: buildTokenRouteDecision(
          credential,
          correlation,
          providerPreference,
          compatTranslation,
          providerUsageRouteMeta.get(credential.id),
          buildRescueRouteDecisionMeta(rescueTracker, {
            provider,
            credential
          })
        ),
        upstreamStatus: status,
        latencyMs: Date.now() - startedAt,
        ttfbMs
      });
      if (status >= 200 && status < 300 && !extractedFailed) {
        await runtime.services.metering.recordUsage({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          tokenCredentialId: credential.id,
          providerAccountId: credential.id,
          servingOrgId: credential.orgId,
          provider,
          model,
          inputTokens,
          outputTokens,
          usageUnits,
          retailEquivalentMinor: usageUnits
        });
        const monthlyUsageRecorded = await runtime.repos.tokenCredentials.addMonthlyContributionUsage(
          credential.id,
          usageUnits
        );
        if (!monthlyUsageRecorded) {
          await logAttemptFailure({
            kind: 'metering_degraded',
            message: 'monthly contribution increment could not be recorded after successful upstream response'
          }, undefined, { archive: false });
        }
      }

      if (status >= 200 && status < 300) {
        runtime.repos.requestLog.insert({
          requestId,
          attemptNo,
          orgId,
          provider,
          model,
          promptPreview: extractRequestPreview(compat.payload, proxiedPath),
          responsePreview: extractResponsePreview(data)
        }).catch(() => {});
      }

      logDegradedSuccess({
        tracker: rescueTracker,
        requestId,
        orgId,
        correlation,
        provider,
        model,
        credential,
        attemptNo
      });

      return {
        requestId,
        keyId: credential.id,
        attemptNo,
        upstreamStatus: downstreamMappedError?.status ?? effectiveStatus,
        usageUnits,
        contentType: downstreamContentType,
        data: downstreamData,
        routeKind: 'token_credential',
        alreadyRecorded: true
      };
    }
  }

  const compatTerminalResult = compatTranslation && terminalCompatError
    ? buildCompatTerminalErrorResult({
      mappedError: terminalCompatError,
      requestId,
      keyId: terminalCompatCredentialId,
      attemptNo: terminalCompatAttemptNo || attemptNo || 1
    })
    : null;

  if (allowCompatTerminalErrorResponse && compatTerminalResult) {
    return compatTerminalResult;
  }

  if (sawAuthFailure) {
    if (lastAuthFailure) {
      logAuthFailureAudit({
        orgId,
        provider,
        model,
        requestId,
        openclawRunId: correlation.openclawRunId,
        openclawSessionId: correlation.openclawSessionId,
        attemptNo: lastAuthFailure.attemptNo,
        credentialId: lastAuthFailure.credentialId,
        credentialLabel: lastAuthFailure.credentialLabel,
        upstreamStatus: lastAuthFailure.status,
        errorType: lastAuthFailure.errorType,
        errorMessage: lastAuthFailure.errorMessage
      });
    }
      throw new AppError('unauthorized', 401, 'All token credentials unauthorized or expired', {
        provider,
        model,
        lastAuthStatus,
        ...(compatTerminalResult ? { compatTerminalResult } : {})
      });
  }

  if (allowCompatTerminalErrorResponse && terminalNative400Result && !sawNonAuthNon400Failure) {
    return terminalNative400Result;
  }

  throw buildTokenCredentialAttemptsExhaustedError({
    provider,
    model,
    compatTerminalResult,
    lastRetryableFailure,
    sawRateLimitFailure
  });
}

async function executeTokenModeStreaming(input: {
  requestId: string;
  orgId: string;
  apiKeyId: string;
  buyerKeyLabel?: string | null;
  correlation: OpenClawCorrelation;
  provider: string;
  model: string;
  payload: unknown;
  proxiedPath: string;
  archiveRequestPayload: unknown;
  archiveRequestPath: string;
  anthropicVersion: string;
  anthropicBeta?: string;
  startedAt: number;
  res: Response;
  idempotencySession: IdempotencySession | null;
  strictUpstreamPassthrough?: boolean;
  providerPreference?: ProviderPreferenceMeta;
  compatTranslation?: CompatTranslationMeta;
  compatMode?: boolean;
  allowCompatTerminalErrorResponse?: boolean;
  rescueTracker?: RescueTracker;
}): Promise<ProxyRouteResult | null> {
  const {
    requestId,
    orgId,
    apiKeyId,
    buyerKeyLabel,
    correlation,
    provider,
    model,
    payload,
    proxiedPath,
    archiveRequestPayload,
    archiveRequestPath,
    anthropicVersion,
    anthropicBeta,
    startedAt,
    res,
    idempotencySession,
    strictUpstreamPassthrough,
    providerPreference,
    compatTranslation,
    compatMode: compatModeFlag,
    allowCompatTerminalErrorResponse,
    rescueTracker
  } = input;

  const {
    credentials,
    providerUsageRouteMeta,
    providerUsageExcludedReasonCounts,
    providerUsageExcludedRouteMeta
  } = await resolveEligibleTokenCredentialsWithAnthropicStaleRecovery({
    orgId,
    provider,
    requestId,
    buyerKeyLabel,
    model,
    allowCompatProviderUsageFailOpen: Boolean(strictUpstreamPassthrough || compatTranslation || compatModeFlag)
  });
  if (credentials.length === 0) {
    throw new AppError('capacity_unavailable', 429, 'No eligible token credentials available', {
      provider,
      model,
      providerUsageExcludedReasonCounts: Object.keys(providerUsageExcludedReasonCounts).length > 0
        ? providerUsageExcludedReasonCounts
        : undefined,
      providerUsageExcludedRouteMeta: Object.keys(providerUsageExcludedRouteMeta).length > 0
        ? providerUsageExcludedRouteMeta
        : undefined
    });
  }

  let attemptNo = 0;
  let sawAuthFailure = false;
  let lastAuthStatus: number | null = null;
  let lastAuthFailure: { attemptNo: number; credentialId: string; credentialLabel?: string | null; status: number; errorType?: string; errorMessage?: string } | null = null;
  let terminalCompatError: ReturnType<typeof mapOpenAiErrorToAnthropic> | null = null;
  let terminalCompatCredentialId: string | null = null;
  let terminalCompatAttemptNo = 0;
  let terminalNative400Result: ProxyRouteResult | null = null;
  let sawNonAuthNon400Failure = false;
  let sawRateLimitFailure = false;
  let lastRetryableFailure: AttemptFailure | null = null;
  const initialSameProviderRetryLimit = selectSameProviderRetryCredentials(credentials).length;
  let allowExpandedSameProviderRetry = false;

  for (let credentialIndex = 0; credentialIndex < credentials.length; credentialIndex += 1) {
    if (credentialIndex >= initialSameProviderRetryLimit && !allowExpandedSameProviderRetry) break;
    attemptNo += 1;
    let credential = credentials[credentialIndex]!;
    let refreshed = false;
    let compat = createCompatNormalizationState(payload, anthropicBeta);
    allowExpandedSameProviderRetry = false;

    while (true) {
      const attemptStartedAt = Date.now();
      const targetUrl = resolveTokenModeTargetUrl({
        provider,
        credential,
        proxiedPath
      });
      const timeoutMs = upstreamTimeoutMs();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const upstreamHeaders = buildTokenModeUpstreamHeaders({
        requestId,
        anthropicVersion,
        anthropicBeta: compat.anthropicBeta,
        provider,
          credential,
          skipOauthDefaultBetas: compat.blockedRetryApplied,
          streaming: true
      });
      const upstreamBody = JSON.stringify(normalizeTokenModeUpstreamPayload({
        provider,
        credential,
        proxiedPath,
        payload: compat.payload ?? {},
        streaming: true
      }));
      const traceAnthropicFirstPass = shouldTraceAnthropicFirstPass({
        provider,
        proxiedPath,
        credential,
        attemptNo,
        compat
      });
      if (traceAnthropicFirstPass) {
        logAnthropicFirstPassTraceRequest({
          requestId,
          attemptNo,
          provider,
          proxiedPath,
          targetUrl,
          credential,
          headers: upstreamHeaders,
          body: upstreamBody,
          streaming: true
        });
      }
      const dispatchStartedAt = Date.now();

      const logAttemptFailure = async (
        failure: AttemptFailure,
        ttfb?: number | null,
        options?: { archive?: boolean }
      ) => {
        await runtime.repos.routingEvents.insert({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          provider,
          model,
          streaming: true,
          routeDecision: buildTokenRouteDecision(
            credential,
            correlation,
            providerPreference,
            compatTranslation,
            providerUsageRouteMeta.get(credential.id)
          ),
          upstreamStatus: failure.statusCode,
          errorCode: inferErrorCode(failure),
          latencyMs: Date.now() - startedAt,
          ttfbMs: ttfb ?? null
        });
        if (options?.archive !== false) {
          await archiveFailedProxyAttempt({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            routeKind: 'token_credential',
            tokenCredentialId: credential.id,
            provider,
            model,
            streaming: true,
            requestPath: archiveRequestPath,
            requestPayload: archiveRequestPayload,
            startedAtMs: startedAt,
            correlation,
            failure
          });
        }
      };

      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: upstreamBody,
        signal: controller.signal
      })
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : 'network error';
          await logAttemptFailure({ kind: 'network', message });
          return null;
        })
        .finally(() => clearTimeout(timer));

      if (!upstreamResponse) {
        const failure = { kind: 'network', message: 'network error' } satisfies AttemptFailure;
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure
        });
        sawNonAuthNon400Failure = true;
        lastRetryableFailure = failure;
        allowExpandedSameProviderRetry = shouldExpandSameProviderRetryBudget(failure);
        break;
      }

      const status = upstreamResponse.status;
      const upstreamHeadersAt = Date.now();
      if (traceAnthropicFirstPass) {
        await logAnthropicFirstPassTraceResponse({
          requestId,
          attemptNo,
          provider,
          proxiedPath,
          targetUrl,
          credential,
          upstreamResponse
        });
      }
      if (status === 403 && strictUpstreamPassthrough) {
        const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
        const data = contentType.includes('application/json')
          ? await upstreamResponse.json().catch(() => ({}))
          : await upstreamResponse.text();
        const blocked = isUpstreamBlockedResponse(status, data);
        if (blocked && !compat.blockedRetryApplied) {
          await recordTokenCredentialOutcome({
            credential,
            requestId,
            attemptNo,
            provider,
            model,
            upstreamStatus: status
          });
          logRetryAudit({
            orgId,
            provider,
            model,
            requestId,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
          attemptNo,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          upstreamStatus: status,
          retryReason: 'blocked_403_compat_retry'
        });
          compat = applyCompatNormalization({
            requestId,
            attemptNo,
            credentialId: credential.id,
            provider,
            credential,
            state: compat,
            reason: 'retry_blocked_403'
          });
          continue;
        }
        if (blocked) {
          await recordTokenCredentialOutcome({
            credential,
            requestId,
            attemptNo,
            provider,
            model,
            upstreamStatus: status
          });
          const { errorType, errorMessage } = extractUpstreamErrorDetails(data);
          await runtime.repos.routingEvents.insert({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            sellerKeyId: undefined,
            provider,
            model,
            streaming: true,
            routeDecision: buildTokenRouteDecision(
              credential,
              correlation,
              providerPreference,
              compatTranslation,
              providerUsageRouteMeta.get(credential.id)
            ),
            upstreamStatus: status,
            errorCode: 'upstream_403_blocked_passthrough',
            latencyMs: Date.now() - startedAt,
            ttfbMs: Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt))
          });
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType,
            errorMessage
          });

          return {
            requestId,
            keyId: credential.id,
            attemptNo,
            upstreamStatus: status,
            usageUnits: 0,
            contentType,
            data,
            routeKind: 'token_credential',
            alreadyRecorded: true
          };
        }
      }

      if (status === 401 || (status === 403 && !compatTranslation)) {
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
        let statusErrorType: string | undefined;
        let statusErrorMessage: string | undefined;
        if (strictUpstreamPassthrough || compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const statusData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
          const details = extractUpstreamErrorDetails(statusData);
          statusErrorType = details.errorType;
          statusErrorMessage = details.errorMessage;
          if (compatTranslation) {
            terminalCompatError = mapOpenAiErrorToAnthropic(status, statusData);
            terminalCompatCredentialId = credential.id;
            terminalCompatAttemptNo = attemptNo;
          }
        }
        if (shouldRetryWithOauthSafeCompatPayload({
          status,
          strictUpstreamPassthrough,
          provider,
          credential,
          alreadyRetried: compat.oauthRetryApplied,
          payload: compat.payload,
          anthropicBeta: compat.anthropicBeta,
          errorType: statusErrorType,
          errorMessage: statusErrorMessage
        })) {
          logRetryAudit({
            orgId,
            provider,
            model,
            requestId,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            attemptNo,
            credentialId: credential.id,
            credentialLabel: credential.debugLabel,
            upstreamStatus: status,
            retryReason: 'oauth_401_compat_retry'
          });
          compat = applyCompatNormalization({
            requestId,
            attemptNo,
            credentialId: credential.id,
            provider,
            credential,
            state: compat,
            reason: 'retry_oauth_401'
          });
          continue;
        }
        if (!refreshed) {
          const next = await attemptTokenCredentialRefresh(runtime.repos.tokenCredentials, credential);
          refreshed = true;
          if (next) {
            logRetryAudit({
              orgId,
              provider,
              model,
              requestId,
              openclawRunId: correlation.openclawRunId,
              openclawSessionId: correlation.openclawSessionId,
              attemptNo,
              credentialId: credential.id,
              credentialLabel: credential.debugLabel,
              upstreamStatus: status,
              retryReason: 'credential_refresh_retry'
            });
            credential = next;
            continue;
          }
        }
        sawAuthFailure = true;
        lastAuthStatus = status;
        lastAuthFailure = {
          attemptNo,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          status,
          errorType: statusErrorType,
          errorMessage: statusErrorMessage
        };
        await logAttemptFailure({ kind: 'auth', statusCode: status, message: 'token auth failed' }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { kind: 'auth', statusCode: status, message: 'token auth failed' }
        });
        if (strictUpstreamPassthrough) {
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType: statusErrorType,
            errorMessage: statusErrorMessage
          });
        }
        break;
      }

      if (status === 429) {
        const rateLimitData = await readUpstreamErrorPayload(upstreamResponse);
        if (compatTranslation) {
          terminalCompatError = mapOpenAiErrorToAnthropic(status, rateLimitData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        }
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
        await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        logRetryAudit({
          orgId,
          provider,
          model,
          requestId,
          openclawRunId: correlation.openclawRunId,
          openclawSessionId: correlation.openclawSessionId,
          attemptNo,
          credentialId: credential.id,
          credentialLabel: credential.debugLabel,
          upstreamStatus: status,
          retryReason: 'rate_limited_backoff'
        });
        const backoffMs = 200 * (2 ** (attemptNo - 1)) + Math.floor(Math.random() * 100);
        await sleep(backoffMs);
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { kind: 'rate_limited', statusCode: 429, message: 'rate limited' }
        });
        sawRateLimitFailure = true;
        sawNonAuthNon400Failure = true;
        break;
      }

      if (status >= 500 && !strictUpstreamPassthrough) {
        const failure = { kind: 'server_error', statusCode: status, message: 'upstream server error' } satisfies AttemptFailure;
        if (compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const upstreamErrorData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
          terminalCompatError = mapOpenAiErrorToAnthropic(status, upstreamErrorData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        }
        await logAttemptFailure(failure, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure
        });
        sawNonAuthNon400Failure = true;
        lastRetryableFailure = failure;
        allowExpandedSameProviderRetry = shouldExpandSameProviderRetryBudget(failure);
        break;
      }

      if (status === 400) {
        const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
        const upstreamErrorData = await readUpstreamErrorPayload(upstreamResponse);
        if (compatTranslation) {
          terminalCompatError = mapOpenAiErrorToAnthropic(status, upstreamErrorData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        } else if (allowCompatTerminalErrorResponse) {
          terminalNative400Result = {
            requestId,
            keyId: credential.id,
            attemptNo,
            upstreamStatus: status,
            usageUnits: 0,
            contentType,
            data: upstreamErrorData,
            routeKind: 'token_credential',
            alreadyRecorded: true
          };
        }
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
        if (strictUpstreamPassthrough) {
          const { errorType, errorMessage } = extractUpstreamErrorDetails(upstreamErrorData);
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType,
            errorMessage
          });
        }
        await logAttemptFailure({ statusCode: status, message: 'upstream provider rejected request' }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { statusCode: status, message: 'upstream provider rejected request' }
        });
        break;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const shouldProbeMislabelledOpenAiSse = !compatTranslation
        && !compatModeFlag
        && parseRelativeProxyUrl(proxiedPath).pathname === '/v1/responses'
        && contentType.includes('application/json');
      const mislabelledOpenAiSse = shouldProbeMislabelledOpenAiSse
        && looksLikeSsePayload(await peekResponseBodyPrefix(upstreamResponse));
      const isStreaming = contentType.includes('text/event-stream') || mislabelledOpenAiSse;
      if (!isStreaming) {
        const { data: rawData, rawText, looksLikeSse } = await readUpstreamBody({
          upstreamResponse,
          contentType
        });
        const extractedSseResponse = status >= 200 && status < 300 && looksLikeSse
          ? extractTerminalOpenAiResponseFromSse(rawText)
          : null;
        const data = extractedSseResponse ?? rawData;
        const extractedStatus = typeof (extractedSseResponse as any)?.status === 'string'
          ? String((extractedSseResponse as any).status)
          : null;
        const extractedFailed = extractedStatus === 'failed';
        const effectiveStatus = extractedFailed ? 500 : status;
        // Map ALL error statuses on translated paths to Anthropic-shaped error envelopes.
        const downstreamMappedError = compatTranslation && (status >= 400 || extractedFailed)
          ? mapOpenAiErrorToAnthropic(effectiveStatus, data)
          : null;
        if (compatTranslation && (status >= 400 || extractedFailed)) {
          logCompatTranslatedUpstreamError({
            requestId,
            credentialId: credential.id,
            credentialLabel: credential.debugLabel,
            provider,
            model,
            translatedPath: compatTranslation.translatedPath,
            translatedModel: compatTranslation.translatedModel,
            upstreamStatus: effectiveStatus,
            upstreamContentType: contentType,
            upstreamError: data
          });
        }
        if (extractedFailed && !strictUpstreamPassthrough) {
          if (compatTranslation && downstreamMappedError) {
            terminalCompatError = downstreamMappedError;
            terminalCompatCredentialId = credential.id;
            terminalCompatAttemptNo = attemptNo;
          }
          await logAttemptFailure({
            kind: 'upstream_failed_stream',
            statusCode: effectiveStatus,
            message: 'upstream responses stream reported failure'
          }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
          rememberRescueFailure(rescueTracker, {
            provider,
            credential,
            attemptNo,
            failure: {
              kind: 'upstream_failed_stream',
              statusCode: effectiveStatus,
              message: 'upstream responses stream reported failure'
            }
          });
          sawNonAuthNon400Failure = true;
          break;
        }
        const downstreamData = compatTranslation && status >= 200 && status < 300 && !extractedFailed
          ? translateOpenAiToAnthropic({
            data,
            model: compatTranslation.originalModel
          })
          : (downstreamMappedError?.body ?? data);
        if (strictUpstreamPassthrough && status >= 400) {
          const { errorType, errorMessage } = extractUpstreamErrorDetails(data);
          logCompatAudit({
            orgId,
            provider,
            model,
            requestId,
            credentialId: credential.id,
            attemptNo,
            upstreamStatus: status,
            openclawRunId: correlation.openclawRunId,
            openclawSessionId: correlation.openclawSessionId,
            errorType,
            errorMessage
          });
        }
        const usage = resolveSyntheticUsageFromPayload(data);
        const { inputTokens, outputTokens, usageUnits, meteringSource } = usage;
        let firstDownstreamWriteAt: number | null = null;
        let streamEndedAt: number | null = null;

        await runtime.repos.routingEvents.insert({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          provider,
          model,
          streaming: true,
          routeDecision: buildTokenRouteDecision(
            credential,
            correlation,
            providerPreference,
            compatTranslation,
            providerUsageRouteMeta.get(credential.id),
            buildRescueRouteDecisionMeta(rescueTracker, {
              provider,
              credential
            })
          ),
          upstreamStatus: effectiveStatus,
          errorCode: extractedFailed ? 'upstream_failed_stream' : (status >= 500 ? 'upstream_5xx_passthrough' : undefined),
          latencyMs: Date.now() - startedAt,
          ttfbMs: Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt))
        });

        // Maintain stream contract for compat callers: if client requested stream=true,
        // do not downgrade a successful response to JSON.
        if (
          status >= 200 &&
          status < 300 &&
          !extractedFailed &&
          typeof (res as any).write === 'function' &&
          typeof (res as any).end === 'function'
        ) {
          await recordTokenCredentialOutcome({
            credential,
            requestId,
            attemptNo,
            provider,
            model,
            upstreamStatus: status
          });
          res.setHeader('x-request-id', requestId);
          res.setHeader('x-innies-token-credential-id', credential.id);
          res.setHeader('x-innies-attempt-no', String(attemptNo));
          res.setHeader('content-type', 'text/event-stream; charset=utf-8');
          res.setHeader('cache-control', 'no-cache, no-transform');
          res.setHeader('connection', 'keep-alive');
          res.setHeader('x-accel-buffering', 'no');
          res.status(status);
          if (typeof (res as any).flushHeaders === 'function') {
            (res as any).flushHeaders();
          }
          if ((res as any).socket) {
            (res as any).socket.setKeepAlive?.(true);
            (res as any).socket.setNoDelay?.(true);
          }

          const useAnthropicSse = !!(compatTranslation || compatModeFlag);
          if (!useAnthropicSse && looksLikeSse) {
            const archivedStreamResponsePayload = extractArchiveResponsePayloadFromStream({
              rawStream: rawText,
              downstreamUsesAnthropicSse: false
            });
            await archiveProxyAttempt({
              requestId,
              attemptNo,
              orgId,
              apiKeyId,
              routeKind: 'token_credential',
              tokenCredentialId: credential.id,
              provider,
              model,
              streaming: true,
              status: 'success',
              upstreamStatus: status,
              requestPath: archiveRequestPath,
              requestPayload: archiveRequestPayload,
              responsePayload: archivedStreamResponsePayload,
              rawStream: rawText,
              startedAtMs: startedAt,
              correlation
            });
            firstDownstreamWriteAt = Date.now();
            (res as any).write(rawText);
            if ((res as any).body === undefined) {
              (res as any).body = rawText;
            }
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
            (res as any).end();
            streamEndedAt = Date.now();

            const parsedInputTokens = extractLastTokenCount(rawText, 'input_tokens');
            const parsedOutputTokens = extractLastTokenCount(rawText, 'output_tokens');
            const totalBytes = Buffer.byteLength(rawText, 'utf8');
            const usageUnits = Math.max(
              0,
              (parsedInputTokens ?? 0) + (parsedOutputTokens ?? 0)
            ) || Math.max(1, Math.ceil(totalBytes / 4));
            const inputTokens = parsedInputTokens ?? Math.floor(usageUnits * 0.4);
            const outputTokens = parsedOutputTokens ?? Math.max(0, usageUnits - inputTokens);
            const meteringSource: MeteringSource = parsedInputTokens === null || parsedOutputTokens === null
              ? 'stream_estimate'
              : 'stream_usage';

            try {
              if (status < 500) {
                await runtime.services.metering.recordUsage({
                  requestId,
                  attemptNo,
                  orgId,
                  apiKeyId,
                  sellerKeyId: undefined,
                  tokenCredentialId: credential.id,
                  providerAccountId: credential.id,
                  servingOrgId: credential.orgId,
                  provider,
                  model,
                  inputTokens,
                  outputTokens,
                  usageUnits,
                  retailEquivalentMinor: usageUnits,
                  note: `metering_source=${meteringSource} stream_mode=buffered_passthrough`
                });

                const monthlyUsageRecorded = await runtime.repos.tokenCredentials.addMonthlyContributionUsage(
                  credential.id,
                  usageUnits
                );
                if (!monthlyUsageRecorded) {
                  await logAttemptFailure({
                    kind: 'metering_degraded',
                    message: 'monthly contribution increment could not be recorded after buffered SSE passthrough'
                  }, undefined, { archive: false });
                }
              }

              if (idempotencySession && !idempotencySession.replay) {
                await commitProxyMetadataIdempotency(
                  idempotencySession,
                  requestId,
                  { type: 'stream_non_replayable', requestId, usageUnits }
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn('[post-stream-bookkeeping] buffered_passthrough_failed', {
                requestId,
                attemptNo,
                credential_id: credential.id,
                message
              });
            }

            console.info('[stream-first-byte]', {
              requestId,
              attemptNo,
              provider,
              model,
              first_byte_ms: (firstDownstreamWriteAt ?? Date.now()) - startedAt,
              synthetic_stream_bridge: false,
              buffered_upstream_sse: true
            });
            console.info('[stream-latency]', {
              requestId,
              attemptNo,
              credential_id: credential.id,
              credential_label: credential.debugLabel ?? null,
              openclaw_run_id: correlation.openclawRunId,
              openclaw_session_id: correlation.openclawSessionId ?? null,
              upstream_status: status,
              upstream_content_type: contentType,
              stream_mode: 'buffered_passthrough',
              synthetic_stream_bridge: false,
              buffered_upstream_sse: true,
              metering_source: meteringSource,
              pre_upstream_ms: dispatchStartedAt - attemptStartedAt,
              upstream_ttfb_ms: upstreamHeadersAt - dispatchStartedAt,
              bridge_build_ms: firstDownstreamWriteAt ? (firstDownstreamWriteAt - upstreamHeadersAt) : null,
              synthetic_content_block_count: null,
              synthetic_content_block_types: null,
              synthetic_output_item_count: null,
              synthetic_output_item_types: null,
              post_stream_write_ms: firstDownstreamWriteAt && streamEndedAt
                ? Math.max(0, streamEndedAt - firstDownstreamWriteAt)
                : null
            });
            if (status >= 200 && status < 300) {
              runtime.repos.requestLog.insert({
                requestId,
                attemptNo,
                orgId,
                provider,
                model,
                promptPreview: extractRequestPreview(compat.payload, proxiedPath),
                responsePreview: extractResponsePreview(rawText)
              }).catch(() => {});
            }
            logDegradedSuccess({
              tracker: rescueTracker,
              requestId,
              orgId,
              correlation,
              provider,
              model,
              credential,
              attemptNo
            });
            return {
              requestId,
              keyId: credential.id,
              attemptNo,
              upstreamStatus: status,
              usageUnits,
              contentType: 'text/event-stream; charset=utf-8',
              data: null,
              routeKind: 'token_credential',
              alreadyRecorded: true
            };
          }

          const syntheticMessage = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
          const downstreamMessage = (downstreamData && typeof downstreamData === 'object'
            ? downstreamData
            : {}) as Record<string, unknown>;
          const anthropicSummary = useAnthropicSse
            ? summarizeSyntheticContentBlocks(compatTranslation ? downstreamMessage : syntheticMessage)
            : null;
          const openAiSummary = useAnthropicSse
            ? null
            : summarizeSyntheticOpenAiOutputItems(syntheticMessage);
          const syntheticPayload = useAnthropicSse
            ? `: keepalive\n\n${buildSyntheticAnthropicSse(
              compatTranslation ? downstreamMessage : syntheticMessage,
              compatTranslation ? compatTranslation.originalModel : model
            )}`
            : `: keepalive\n\n${buildSyntheticOpenAiResponsesSse(syntheticMessage)}`;
          const streamMode = useAnthropicSse ? 'synthetic_bridge' : 'synthetic_openai_responses_bridge';
          const syntheticFormat = useAnthropicSse ? 'anthropic' : 'openai_responses';
          await archiveProxyAttempt({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            routeKind: 'token_credential',
            tokenCredentialId: credential.id,
            provider,
            model,
            streaming: true,
            status: 'success',
            upstreamStatus: status,
            requestPath: archiveRequestPath,
            requestPayload: archiveRequestPayload,
            responsePayload: downstreamData,
            rawStream: syntheticPayload,
            startedAtMs: startedAt,
            correlation
          });
          firstDownstreamWriteAt = Date.now();
          (res as any).write(syntheticPayload);
          if ((res as any).body === undefined) {
            (res as any).body = syntheticPayload;
          }
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
          (res as any).end();
          streamEndedAt = Date.now();

          try {
            if (status < 500) {
              await runtime.services.metering.recordUsage({
                requestId,
                attemptNo,
                orgId,
                apiKeyId,
                sellerKeyId: undefined,
                tokenCredentialId: credential.id,
                providerAccountId: credential.id,
                servingOrgId: credential.orgId,
                provider,
                model,
                inputTokens,
                outputTokens,
                usageUnits,
                retailEquivalentMinor: usageUnits,
                note: `metering_source=${meteringSource} stream_mode=${streamMode}`
              });

              const monthlyUsageRecorded = await runtime.repos.tokenCredentials.addMonthlyContributionUsage(
                credential.id,
                usageUnits
              );
              if (!monthlyUsageRecorded) {
                await logAttemptFailure({
                  kind: 'metering_degraded',
                  message: 'monthly contribution increment could not be recorded after successful upstream non-stream response'
                }, undefined, { archive: false });
              }
            }

            if (idempotencySession && !idempotencySession.replay) {
              await commitProxyMetadataIdempotency(
                idempotencySession,
                requestId,
                { type: 'stream_non_replayable', requestId, usageUnits }
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[post-stream-bookkeeping] synthetic_bridge_failed', {
              requestId,
              attemptNo,
              credential_id: credential.id,
              message
            });
          }
          console.info('[stream-first-byte]', {
            requestId,
            attemptNo,
            provider,
            model,
            first_byte_ms: (firstDownstreamWriteAt ?? Date.now()) - startedAt,
            synthetic_stream_bridge: true,
            synthetic_stream_format: syntheticFormat
          });
          console.info('[stream-latency]', {
            requestId,
            attemptNo,
            credential_id: credential.id,
            credential_label: credential.debugLabel ?? null,
            openclaw_run_id: correlation.openclawRunId,
            openclaw_session_id: correlation.openclawSessionId ?? null,
            upstream_status: status,
            upstream_content_type: contentType,
            stream_mode: streamMode,
            synthetic_stream_bridge: true,
            synthetic_stream_format: syntheticFormat,
            metering_source: meteringSource,
            pre_upstream_ms: dispatchStartedAt - attemptStartedAt,
            upstream_ttfb_ms: upstreamHeadersAt - dispatchStartedAt,
            bridge_build_ms: firstDownstreamWriteAt ? (firstDownstreamWriteAt - upstreamHeadersAt) : null,
            synthetic_content_block_count: anthropicSummary?.count ?? null,
            synthetic_content_block_types: anthropicSummary?.types ?? null,
            synthetic_output_item_count: openAiSummary?.count ?? null,
            synthetic_output_item_types: openAiSummary?.types ?? null,
            post_stream_write_ms: firstDownstreamWriteAt && streamEndedAt
              ? Math.max(0, streamEndedAt - firstDownstreamWriteAt)
              : null
          });
          if (status >= 200 && status < 300 && !extractedFailed) {
            runtime.repos.requestLog.insert({
              requestId,
              attemptNo,
              orgId,
              provider,
              model,
              promptPreview: extractRequestPreview(compat.payload, proxiedPath),
              responsePreview: extractResponsePreview(data)
            }).catch(() => {});
          }
          if (status >= 200 && status < 300 && !extractedFailed) {
            logDegradedSuccess({
              tracker: rescueTracker,
              requestId,
              orgId,
              correlation,
              provider,
              model,
              credential,
              attemptNo
            });
          }
          return {
            requestId,
            keyId: credential.id,
            attemptNo,
            upstreamStatus: status,
            usageUnits,
            contentType: 'text/event-stream; charset=utf-8',
            data: null,
            routeKind: 'token_credential',
            alreadyRecorded: true
          };
        }

        return {
          requestId,
          keyId: credential.id,
          attemptNo,
          upstreamStatus: downstreamMappedError?.status ?? effectiveStatus,
          usageUnits,
          contentType: compatTranslation ? 'application/json' : contentType,
          data: downstreamData,
          routeKind: 'token_credential',
          alreadyRecorded: true
        };
      }

      res.setHeader('x-request-id', requestId);
      res.setHeader('x-innies-token-credential-id', credential.id);
      res.setHeader('x-innies-attempt-no', String(attemptNo));
      const downstreamContentType = (compatTranslation || mislabelledOpenAiSse)
        ? 'text/event-stream; charset=utf-8'
        : contentType;
      res.setHeader('content-type', downstreamContentType);
      // Force pass-through semantics for SSE across reverse proxies.
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.status(status);
      if (typeof (res as any).flushHeaders === 'function') {
        (res as any).flushHeaders();
      }
      if ((res as any).socket) {
        (res as any).socket.setKeepAlive?.(true);
        (res as any).socket.setNoDelay?.(true);
      }

      if (!upstreamResponse.body) {
        await logAttemptFailure({ kind: 'network', message: 'upstream stream missing body' }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        rememberRescueFailure(rescueTracker, {
          provider,
          credential,
          attemptNo,
          failure: { kind: 'network', message: 'upstream stream missing body' }
        });
        sawNonAuthNon400Failure = true;
        break;
      }
      await runtime.repos.routingEvents.insert({
        requestId,
        attemptNo,
        orgId,
        apiKeyId,
        sellerKeyId: undefined,
        provider,
        model,
        streaming: true,
        routeDecision: buildTokenRouteDecision(
          credential,
          correlation,
          providerPreference,
          compatTranslation,
          providerUsageRouteMeta.get(credential.id),
          buildRescueRouteDecisionMeta(rescueTracker, {
            provider,
            credential
          })
        ),
        upstreamStatus: status,
        latencyMs: Date.now() - startedAt,
        ttfbMs: Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt))
      });

      let totalBytes = 0;
      let totalChunks = 0;
      let sampled = '';
      let firstByteAt: number | null = null;
      let firstDownstreamWriteAt: number | null = null;
      let streamEndedAt: number | null = null;
      let streamTruncated = false;
      const downstreamUsesAnthropicSse = Boolean(compatTranslation) || provider === 'anthropic';
      const heartbeatMs = sseHeartbeatIntervalMs();
      const writeKeepalive = () => {
        if ((res as any).writableEnded || (res as any).destroyed) return;
        if (firstDownstreamWriteAt === null) {
          firstDownstreamWriteAt = Date.now();
        }
        (res as any).write(': keepalive\n\n');
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      };
      // Emit one frame immediately so clients with short first-byte deadlines do not timeout.
      writeKeepalive();
      const keepaliveTimer = setInterval(writeKeepalive, heartbeatMs);
      let pipelineError: unknown = null;
      try {
        const upstreamReadable = Readable.fromWeb(upstreamResponse.body as any);
        const responseStream = compatTranslation
          ? upstreamReadable.pipe(new OpenAiToAnthropicStreamTransform({
            model: compatTranslation.originalModel
          }))
          : upstreamReadable;
        await writeReadableToResponse({
          source: responseStream,
          res,
          onChunk: (buffer) => {
            if (firstByteAt === null) {
              firstByteAt = Date.now();
              console.info('[stream-first-byte]', {
                requestId,
                attemptNo,
                provider,
                model,
                first_byte_ms: firstByteAt - startedAt,
                mislabelled_upstream_sse: mislabelledOpenAiSse
              });
            }
            totalBytes += buffer.length;
            totalChunks += 1;
            sampled = (sampled + buffer.toString('utf8')).slice(-200_000);
          },
          onDownstreamWrite: () => {
            if (firstDownstreamWriteAt === null) {
              firstDownstreamWriteAt = Date.now();
            }
          }
        });
      } catch (error) {
        pipelineError = error;
        const downstreamClosed = isDownstreamClientDisconnect(res, error);
        const terminalEventSeen = downstreamUsesAnthropicSse
          ? hasTerminalAnthropicStreamEvent(sampled)
          : hasTerminalOpenAiResponsesStreamEvent(sampled);
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.warn('[stream-pipeline-error]', {
          requestId,
          attemptNo,
          provider,
          model,
          compat_translation: Boolean(compatTranslation),
          downstream_closed: downstreamClosed,
          terminal_event_seen: terminalEventSeen,
          error_name: error instanceof Error ? error.name : null,
          error_message: errorMessage,
          error_code: error && typeof error === 'object' ? (error as any).code ?? null : null
        });

        if (!downstreamClosed && !terminalEventSeen && !(res as any).writableEnded && !(res as any).destroyed) {
          streamTruncated = true;
          if (firstDownstreamWriteAt === null) {
            firstDownstreamWriteAt = Date.now();
          }
          const terminalSse = buildSyntheticPassthroughFailureSse({
            downstreamUsesAnthropicSse,
            id: requestId,
            model,
            anthropicModel: compatTranslation ? compatTranslation.originalModel : model
          });
          (res as any).write(terminalSse);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
          (res as any).end();
          sampled = `${sampled}${terminalSse}`.slice(-200_000);
        }
      } finally {
        clearInterval(keepaliveTimer);
        streamEndedAt = Date.now();
      }
      const terminalStatus = downstreamUsesAnthropicSse
        ? resolveAnthropicStreamTerminalStatus(sampled)
        : resolveOpenAiResponsesStreamTerminalStatus(sampled);
      const anthropicStreamErrorDetails = downstreamUsesAnthropicSse
        ? extractAnthropicStreamErrorDetails(sampled)
        : {};
      if (!pipelineError && terminalStatus === 'missing' && !(res as any).destroyed && !(res as any).writableEnded) {
        streamTruncated = true;
        if (firstDownstreamWriteAt === null) {
          firstDownstreamWriteAt = Date.now();
        }
        const terminalSse = buildSyntheticPassthroughFailureSse({
          downstreamUsesAnthropicSse,
          id: requestId,
          model,
          anthropicModel: compatTranslation ? compatTranslation.originalModel : model
        });
        (res as any).write(terminalSse);
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
        (res as any).end();
        sampled = `${sampled}${terminalSse}`.slice(-200_000);
      }
      if (!(res as any).destroyed && !(res as any).writableEnded) {
        (res as any).end();
      }
      if (typeof (res as any).body !== 'string') {
        (res as any).body = `: keepalive\n\n${sampled}`;
      } else if (!(res as any).body.includes(sampled)) {
        (res as any).body = `${(res as any).body}${sampled}`;
      }

      const parsedInputTokens = extractLastTokenCount(sampled, 'input_tokens');
      const parsedOutputTokens = extractLastTokenCount(sampled, 'output_tokens');
      const estimatedUnits = Math.max(1, Math.ceil(totalBytes / 4));
      const usageUnits = Math.max(
        0,
        (parsedInputTokens ?? 0) + (parsedOutputTokens ?? 0)
      ) || estimatedUnits;
      const inputTokens = parsedInputTokens ?? Math.floor(usageUnits * 0.4);
      const outputTokens = parsedOutputTokens ?? Math.max(0, usageUnits - inputTokens);
      const usedEstimate = parsedInputTokens === null || parsedOutputTokens === null;
      const meteringSource: MeteringSource = usedEstimate ? 'stream_estimate' : 'stream_usage';
      const streamCompleted = !streamTruncated && terminalStatus === 'completed';
      const shouldRecordCredentialSuccess = (
        status >= 200
        && status < 300
        && streamCompleted
      );
      const shouldRecordUsage = (
        status >= 200
        && status < 300
        && streamCompleted
      );
      const streamFailureCode = !streamCompleted
        ? (terminalStatus === 'failed' && !streamTruncated ? 'stream_failed_terminal' : 'stream_truncated')
        : null;

      if (
        streamFailureCode === 'stream_failed_terminal'
        && provider === 'anthropic'
        && providerPreference
        && providerPreference.selectionReason !== 'cli_provider_pinned'
        && providerPreference.preferredProvider === 'anthropic'
        && providerPreference.effectiveProvider === 'anthropic'
        && providerPreference.providerPlan.includes('openai')
        && anthropicStreamErrorDetails.errorType === 'overloaded_error'
      ) {
        armNextPromptProviderOverride({
          apiKeyId,
          openclawSessionId: correlation.openclawSessionId ?? null,
          preferredProvider: 'openai',
          armedByRequestId: requestId
        });
      }

      if (streamFailureCode) {
        const streamFailureRouteDecision = buildTokenRouteDecision(
          credential,
          correlation,
          providerPreference,
          compatTranslation,
          providerUsageRouteMeta.get(credential.id)
        );
        if (streamFailureCode === 'stream_failed_terminal') {
          Object.assign(
            streamFailureRouteDecision,
            extractStreamTerminalErrorMetadata({
              downstreamUsesAnthropicSse,
              raw: sampled
            }) ?? {}
          );
        }
        await runtime.repos.routingEvents.insert({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          provider,
          model,
          streaming: true,
          routeDecision: streamFailureRouteDecision,
          upstreamStatus: status,
          errorCode: streamFailureCode,
          latencyMs: Date.now() - startedAt,
          ttfbMs: Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt))
        });
      }

      if (shouldRecordCredentialSuccess) {
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
      }

      try {
        if (shouldRecordUsage && idempotencySession && !idempotencySession.replay) {
          await commitProxyMetadataIdempotency(
            idempotencySession,
            requestId,
            { type: 'stream_non_replayable', requestId, usageUnits }
          );
        }

        if (shouldRecordUsage) {
          const monthlyUsageRecorded = await runtime.repos.tokenCredentials.addMonthlyContributionUsage(
            credential.id,
            usageUnits
          );
          if (!monthlyUsageRecorded) {
            await logAttemptFailure({
              kind: 'metering_degraded',
              message: 'monthly contribution increment could not be recorded after successful upstream stream'
            }, undefined, { archive: false });
          }

          await runtime.services.metering.recordUsage({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            sellerKeyId: undefined,
            tokenCredentialId: credential.id,
            providerAccountId: credential.id,
            servingOrgId: credential.orgId,
            provider,
            model,
            inputTokens,
            outputTokens,
            usageUnits,
            retailEquivalentMinor: usageUnits,
            note: usedEstimate
              ? `metering_source=${meteringSource} estimate=stream_bytes_v1 bytes=${totalBytes} chunks=${totalChunks} reconcile_pending=true`
              : `metering_source=${meteringSource} source=stream_usage_payload bytes=${totalBytes} chunks=${totalChunks}`
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[post-stream-bookkeeping] passthrough_failed', {
          requestId,
          attemptNo,
          credential_id: credential.id,
          message
        });
      }
      console.info('[stream-latency]', {
        requestId,
        attemptNo,
        credential_id: credential.id,
        credential_label: credential.debugLabel ?? null,
        openclaw_run_id: correlation.openclawRunId,
        openclaw_session_id: correlation.openclawSessionId ?? null,
        upstream_status: status,
        upstream_content_type: contentType,
        stream_mode: compatTranslation ? 'translated_passthrough' : 'passthrough',
        synthetic_stream_bridge: false,
        mislabelled_upstream_sse: mislabelledOpenAiSse,
        metering_source: meteringSource,
        pre_upstream_ms: dispatchStartedAt - attemptStartedAt,
        upstream_ttfb_ms: firstByteAt !== null ? (firstByteAt - dispatchStartedAt) : (upstreamHeadersAt - dispatchStartedAt),
        bridge_build_ms: null,
        post_stream_write_ms: firstDownstreamWriteAt && streamEndedAt
          ? Math.max(0, streamEndedAt - firstDownstreamWriteAt)
          : null
      });

      if (status >= 200 && status < 300 && shouldRecordUsage) {
        runtime.repos.requestLog.insert({
          requestId,
          attemptNo,
          orgId,
          provider,
          model,
          promptPreview: extractRequestPreview(compat.payload, proxiedPath),
          responsePreview: extractResponsePreview(sampled)
        }).catch(() => {});
      }
      if (status >= 200 && status < 300 && shouldRecordUsage) {
        logDegradedSuccess({
          tracker: rescueTracker,
          requestId,
          orgId,
          correlation,
          provider,
          model,
          credential,
          attemptNo
        });
      }

      const archivedStreamResponsePayload = extractArchiveResponsePayloadFromStream({
        rawStream: sampled,
        downstreamUsesAnthropicSse
      });
      await archiveProxyAttempt({
        requestId,
        attemptNo,
        orgId,
        apiKeyId,
        routeKind: 'token_credential',
        tokenCredentialId: credential.id,
        provider,
        model,
        streaming: true,
        status: streamFailureCode
          ? (streamFailureCode === 'stream_failed_terminal' ? 'failed' : 'partial')
          : 'success',
        upstreamStatus: status,
        errorCode: streamFailureCode,
        requestPath: archiveRequestPath,
        requestPayload: archiveRequestPayload,
        responsePayload: archivedStreamResponsePayload,
        rawStream: sampled,
        startedAtMs: startedAt,
        correlation
      });

      return null;
    }
  }

  const compatTerminalResult = compatTranslation && terminalCompatError
    ? buildCompatTerminalErrorResult({
      mappedError: terminalCompatError,
      requestId,
      keyId: terminalCompatCredentialId,
      attemptNo: terminalCompatAttemptNo || attemptNo || 1
    })
    : null;

  if (allowCompatTerminalErrorResponse && compatTerminalResult) {
    return compatTerminalResult;
  }

  if (sawAuthFailure) {
    if (lastAuthFailure) {
      logAuthFailureAudit({
        orgId,
        provider,
        model,
        requestId,
        openclawRunId: correlation.openclawRunId,
        openclawSessionId: correlation.openclawSessionId,
        attemptNo: lastAuthFailure.attemptNo,
        credentialId: lastAuthFailure.credentialId,
        credentialLabel: lastAuthFailure.credentialLabel,
        upstreamStatus: lastAuthFailure.status,
        errorType: lastAuthFailure.errorType,
        errorMessage: lastAuthFailure.errorMessage
      });
    }
      throw new AppError('unauthorized', 401, 'All token credentials unauthorized or expired', {
        provider,
        model,
        lastAuthStatus,
        ...(compatTerminalResult ? { compatTerminalResult } : {})
      });
  }

  throw buildTokenCredentialAttemptsExhaustedError({
    provider,
    model,
    compatTerminalResult,
    lastRetryableFailure,
    sawRateLimitFailure
  });
}

export async function proxyPostHandler(req: any, res: Response, next: any): Promise<void> {
  const startedAt = Date.now();
  let observedInputTokens = 0;
  let observedOutputTokens = 0;
  try {
    const compatMode = Boolean(req.inniesCompatMode);
    const auth = req.auth;
    if (!auth?.orgId) {
      throw new AppError('forbidden', 403, 'API key is not associated with an org');
    }
    const orgId = auth.orgId;

    const proxiedPath = req.inniesProxiedPath ?? extractProxyPath(req.originalUrl);
    const parsed = parseProxyRequestBody(req.body, proxiedPath);
    const requestProvider = canonicalizeProvider(parsed.provider);
    const requestId = buildRequestId(req.header('x-request-id') ?? undefined);
    const correlation = resolveOpenClawCorrelation(req, requestId);
    const rawIdempotencyKey = req.header('idempotency-key') ?? undefined;
    const shouldPersistIdempotency = Boolean(rawIdempotencyKey);
    const idempotencyKey = shouldPersistIdempotency
      ? readAndValidateIdempotencyKey(rawIdempotencyKey)
      : generateCompatIdempotencyKey(requestId);

    if (await runtime.repos.killSwitch.isDisabled('global', '*')) {
      throw new AppError('suspended', 423, 'Proxy is globally disabled');
    }

    if (await runtime.repos.killSwitch.isDisabled('org', orgId)) {
      throw new AppError('suspended', 423, 'Org is disabled');
    }

    const idempotencyScope = 'proxy.v1';
    const requestHash = sha256Hex(
      stableJson({
        method: req.method,
        path: req.path,
        orgId,
        provider: requestProvider,
        model: parsed.model,
        streaming: parsed.streaming,
        payload: parsed.payload ?? null
      })
    );

    const idemStart = shouldPersistIdempotency
      ? await runtime.services.idempotency.start({
        scope: idempotencyScope,
        tenantScope: orgId,
        idempotencyKey,
        requestHash
      })
      : null;

    if (idemStart?.replay) {
      sendProxyReplayNotSupported(res, requestId);
      return;
    }

    const tokenModeEnabled = isTokenModeEnabledForOrg(orgId);
    if (compatMode && !tokenModeEnabled) {
      throw new AppError('forbidden', 403, 'Token mode not enabled for org', { orgId });
    }
    if (isTokenModePolicyActive() && !tokenModeEnabled) {
      throw new AppError('forbidden', 403, 'Token mode not enabled for org', { orgId });
    }

    const anthropicVersion = req.header('anthropic-version') ?? '2023-06-01';
    const anthropicBeta = req.header('anthropic-beta') ?? undefined;
    let result: ProxyRouteResult | null = null;
    const requestPinSelectionReason = (readProviderPinSignal(req) || isClaudeCliPinnedRequest(req, proxiedPath))
      ? 'cli_provider_pinned'
      : null;
    const forceRequestProviderPlan = shouldLockTokenModeProviderPlanToRequestProvider({
      compatMode,
      proxiedPath,
      requestProvider
    });
    const nextPromptProviderOverride = requestPinSelectionReason
      ? null
      : consumeNextPromptProviderOverride({
          apiKeyId: auth.apiKeyId,
          openclawSessionId: correlation.openclawSessionId ?? null
        });
    if (tokenModeEnabled) {
      const {
        providerPlan,
        preferredProvider,
        pinSelectionReason: effectivePinSelectionReason
      } = parseProviderPreferencePlan({
        preferredProvider: nextPromptProviderOverride?.preferredProvider ?? auth.preferredProvider,
        preferredProviderSource: auth.preferredProviderSource,
        requestProvider,
        pinSelectionReason: requestPinSelectionReason,
        forceRequestProviderPlan
      });

      let previousProvider: string | undefined;
      let previousReason: string | undefined;
      let terminalError: unknown = null;
      let deferredCompatTerminalResult: ProxyRouteResult | null = null;
      const rescueTracker: RescueTracker = { firstFailure: null };

      for (const provider of providerPlan) {
        try {
          const upstreamRequest = resolveCompatUpstreamRequest({
            compatMode,
            provider,
            model: parsed.model,
            proxiedPath,
            payload: parsed.payload ?? {},
            strictUpstreamPassthrough: compatMode
          });
          await assertTokenProviderEligible({
            provider: upstreamRequest.provider,
            model: upstreamRequest.model,
            streaming: parsed.streaming
          });
          const providerPreference: ProviderPreferenceMeta = {
            preferredProvider,
            effectiveProvider: provider,
            fallbackFromProvider: previousProvider,
            fallbackReason: previousReason,
            providerPlan,
            selectionReason: resolveProviderSelectionReason({
              provider,
              preferredProvider,
              fallbackFromProvider: previousProvider,
              pinSelectionReason: effectivePinSelectionReason
            })
          };
          if (parsed.streaming) {
            const streamedResult = await executeTokenModeStreaming({
              requestId,
              orgId,
              apiKeyId: auth.apiKeyId,
              buyerKeyLabel: auth.buyerKeyLabel ?? null,
              correlation,
              provider: upstreamRequest.provider,
              model: upstreamRequest.model,
              payload: upstreamRequest.payload,
              proxiedPath: upstreamRequest.proxiedPath,
              archiveRequestPayload: parsed.payload ?? {},
              archiveRequestPath: proxiedPath,
              anthropicVersion,
              anthropicBeta,
              startedAt,
              res,
              idempotencySession: idemStart,
              strictUpstreamPassthrough: upstreamRequest.strictUpstreamPassthrough,
              providerPreference,
              compatTranslation: upstreamRequest.compatTranslation,
              compatMode,
              allowCompatTerminalErrorResponse: provider === providerPlan[providerPlan.length - 1],
              rescueTracker
            });
            if (streamedResult === null || res.headersSent || res.writableEnded) return;
            result = streamedResult;
          } else {
            result = await executeTokenModeNonStreaming({
              requestId,
              orgId,
              apiKeyId: auth.apiKeyId,
              buyerKeyLabel: auth.buyerKeyLabel ?? null,
              correlation,
              provider: upstreamRequest.provider,
              model: upstreamRequest.model,
              payload: upstreamRequest.payload,
              proxiedPath: upstreamRequest.proxiedPath,
              archiveRequestPayload: parsed.payload ?? {},
              archiveRequestPath: proxiedPath,
              anthropicVersion,
              anthropicBeta,
              startedAt,
              strictUpstreamPassthrough: upstreamRequest.strictUpstreamPassthrough,
              providerPreference,
              compatTranslation: upstreamRequest.compatTranslation,
              allowCompatTerminalErrorResponse: provider === providerPlan[providerPlan.length - 1],
              rescueTracker
            });
          }
          terminalError = null;
          break;
        } catch (error) {
          terminalError = error;
          const compatTerminalResult = error instanceof AppError
            ? ((error.details as Record<string, unknown> | undefined)?.compatTerminalResult as ProxyRouteResult | undefined)
            : undefined;
          if (compatTerminalResult && !deferredCompatTerminalResult) {
            deferredCompatTerminalResult = compatTerminalResult;
          }
          const reason = providerFallbackReasonForError(error);
          if (!reason || provider === providerPlan[providerPlan.length - 1]) {
            if (deferredCompatTerminalResult) {
              result = deferredCompatTerminalResult;
              terminalError = null;
              break;
            }
            throw error;
          }
          previousProvider = provider;
          previousReason = reason;
        }
      }

      if (terminalError) {
        throw terminalError;
      }
    } else {
      if (await runtime.repos.killSwitch.isDisabled('model', `${requestProvider}:${parsed.model}`)) {
        throw new AppError('suspended', 423, 'Model is disabled');
      }
      const compatible = await runtime.repos.modelCompatibility.findActive(requestProvider, parsed.model);
      if (!compatible) {
        throw new AppError('model_invalid', 400, 'No active compatibility rule for provider/model');
      }
      if (parsed.streaming && !compatible.supports_streaming) {
        throw new AppError('model_invalid', 400, 'Streaming not supported for provider/model');
      }
      const keys = await runtime.repos.sellerKeys.listActiveForRouting(requestProvider, parsed.model, parsed.streaming);
      runtime.services.keyPool.setKeys(keys);
      const buyerOwnership = await runtime.repos.fnfOwnership.findBuyerKeyOwnership(auth.apiKeyId);
      if (buyerOwnership?.owner_org_id === orgId) {
        await runtime.services.wallets.ensurePaidAdmissionEligible({
          walletId: runtime.services.wallets.walletIdForOrgId(orgId),
          trigger: 'paid_team_capacity'
        });
      }

      const sellerResult = await runtime.services.routingService.execute({
        request: {
          requestId,
          orgId,
          provider: requestProvider,
          model: parsed.model,
          streaming: parsed.streaming,
        },
        runUpstream: async (decision) => {
          const sellerRouteDecision = buildSellerRouteDecision({
            routeReason: decision.reason,
            provider: requestProvider,
            correlation,
            pinSelectionReason: requestPinSelectionReason
          });
          const logAttemptFailure = async (
            failure: AttemptFailure,
            ttfb?: number | null,
            options?: { archive?: boolean }
          ) => {
            await runtime.repos.routingEvents.insert({
              requestId,
              attemptNo: decision.attemptNo,
              orgId,
              apiKeyId: auth.apiKeyId,
              sellerKeyId: decision.sellerKeyId,
              provider: requestProvider,
              model: parsed.model,
              streaming: parsed.streaming,
              routeDecision: sellerRouteDecision,
              upstreamStatus: failure.statusCode,
              errorCode: inferErrorCode(failure),
              latencyMs: Date.now() - startedAt,
              ttfbMs: ttfb ?? null
            });
            if (options?.archive !== false) {
              await archiveFailedProxyAttempt({
                requestId,
                attemptNo: decision.attemptNo,
                orgId,
                apiKeyId: auth.apiKeyId,
                routeKind: 'seller_key',
                sellerKeyId: decision.sellerKeyId,
                provider: requestProvider,
                model: parsed.model,
                streaming: parsed.streaming,
                requestPath: proxiedPath,
                requestPayload: parsed.payload ?? {},
                startedAtMs: startedAt,
                correlation,
                failure
              });
            }
          };

          const sellerKey = await runtime.repos.sellerKeys.getSecret(decision.sellerKeyId);
          if (!sellerKey) {
            await logAttemptFailure({ kind: 'auth', message: 'seller key not found' });
            throw Object.assign(new Error('seller key not found'), { kind: 'auth', keySpecific: true });
          }

          const baseUrl = upstreamBaseUrl(requestProvider);
          const targetUrl = new URL(proxiedPath, baseUrl);
          const timeoutMs = upstreamTimeoutMs();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          const payload = parsed.payload ?? {};
          const dispatchStartedAt = Date.now();
          const upstreamResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-request-id': requestId,
              'x-api-key': sellerKey.secret,
              'anthropic-version': req.header('anthropic-version') ?? '2023-06-01'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          })
            .catch(async (error: unknown) => {
              const message = error instanceof Error ? error.message : 'network error';
              await logAttemptFailure({ kind: 'network', message });
              throw Object.assign(new Error(message), { kind: 'network' });
            })
            .finally(() => clearTimeout(timer));
          const upstreamHeadersAt = Date.now();
          const ttfbMs = Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt));

          if (upstreamResponse.status === 429) {
            await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' }, ttfbMs);
            throw Object.assign(new Error('rate limited'), { kind: 'rate_limited', statusCode: 429 });
          }

          if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
            await logAttemptFailure({ kind: 'auth', statusCode: upstreamResponse.status, message: 'auth failed' }, ttfbMs);
            throw Object.assign(new Error('auth failed'), { kind: 'auth', keySpecific: true, statusCode: upstreamResponse.status });
          }

          if (upstreamResponse.status >= 500) {
            await logAttemptFailure({ kind: 'server_error', statusCode: upstreamResponse.status, message: 'upstream server error' }, ttfbMs);
            throw Object.assign(new Error('upstream server error'), { kind: 'server_error', statusCode: upstreamResponse.status });
          }

          const contentType = upstreamResponse.headers.get('content-type') ?? '';
          const isStreaming = contentType.includes('text/event-stream');

          if (parsed.streaming && isStreaming) {
            res.setHeader('x-request-id', requestId);
            res.setHeader('content-type', contentType);
            res.status(upstreamResponse.status);

            if (!upstreamResponse.body) {
              await logAttemptFailure({ kind: 'network', message: 'upstream stream missing body' }, ttfbMs);
              throw Object.assign(new Error('upstream stream missing body'), { kind: 'network' });
            }

            let totalBytes = 0;
            let totalChunks = 0;
            let sampled = '';
            const meter = new Transform({
              transform(chunk, _encoding, callback) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += buffer.length;
                totalChunks += 1;
                sampled = (sampled + buffer.toString('utf8')).slice(-200_000);
                callback(null, chunk);
              }
            });

            try {
              await pipeline(Readable.fromWeb(upstreamResponse.body as any), meter, res);
            } catch {
              // Clients can disconnect mid-stream; retain observed usage for reconciliation.
            }

            const parsedInputTokens = extractLastTokenCount(sampled, 'input_tokens');
            const parsedOutputTokens = extractLastTokenCount(sampled, 'output_tokens');
            const estimatedUnits = Math.max(1, Math.ceil(totalBytes / 4));
            const usageUnits = Math.max(
              0,
              (parsedInputTokens ?? 0) + (parsedOutputTokens ?? 0)
            ) || estimatedUnits;
            const inputTokens = parsedInputTokens ?? Math.floor(usageUnits * 0.4);
            const outputTokens = parsedOutputTokens ?? Math.max(0, usageUnits - inputTokens);
            const usedEstimate = parsedInputTokens === null || parsedOutputTokens === null;
            const shouldRecordServedStream = (
              upstreamResponse.status >= 200
              && upstreamResponse.status < 300
            );

            if (idemStart && !idemStart.replay) {
              await commitProxyMetadataIdempotency(
                idemStart,
                requestId,
                { type: 'stream_non_replayable', requestId, usageUnits }
              );
            }

            if (shouldRecordServedStream) {
              await runtime.repos.sellerKeys.addCapacityUsage(decision.sellerKeyId, usageUnits);
            }
            await runtime.repos.routingEvents.insert({
              requestId,
              attemptNo: decision.attemptNo,
              orgId,
              apiKeyId: auth.apiKeyId,
              sellerKeyId: decision.sellerKeyId,
              provider: requestProvider,
              model: parsed.model,
              streaming: true,
              routeDecision: sellerRouteDecision,
              upstreamStatus: upstreamResponse.status,
              latencyMs: Date.now() - startedAt,
              ttfbMs
            });
            if (shouldRecordServedStream) {
              await runtime.services.metering.recordUsage({
                requestId,
                attemptNo: decision.attemptNo,
                orgId,
                apiKeyId: auth.apiKeyId,
                sellerKeyId: decision.sellerKeyId,
                provider: requestProvider,
                model: parsed.model,
                inputTokens,
                outputTokens,
                usageUnits,
                retailEquivalentMinor: usageUnits,
                note: usedEstimate
                  ? `estimate=stream_bytes_v1 bytes=${totalBytes} chunks=${totalChunks} reconcile_pending=true`
                  : `source=stream_usage_payload bytes=${totalBytes} chunks=${totalChunks}`
              });
            }

            await archiveProxyAttempt({
              requestId,
              attemptNo: decision.attemptNo,
              orgId,
              apiKeyId: auth.apiKeyId,
              routeKind: 'seller_key',
              sellerKeyId: decision.sellerKeyId,
              provider: requestProvider,
              model: parsed.model,
              streaming: true,
              status: shouldRecordServedStream ? 'success' : 'failed',
              upstreamStatus: upstreamResponse.status,
              errorCode: shouldRecordServedStream ? null : `upstream_${upstreamResponse.status}`,
              requestPath: proxiedPath,
              requestPayload: payload,
              responsePayload: extractArchiveResponsePayloadFromStream({
                rawStream: sampled,
                downstreamUsesAnthropicSse: requestProvider === 'anthropic'
              }),
              rawStream: sampled,
              startedAtMs: startedAt,
              correlation
            });

            return {
              upstreamStatus: upstreamResponse.status,
              contentType,
              data: null,
              usageUnits,
              routeDecision: sellerRouteDecision,
              ttfbMs
            };
          }
          const contentTypeOut = upstreamResponse.headers.get('content-type') ?? 'application/json';
          let data: unknown;
          if (contentTypeOut.includes('application/json')) {
            data = await upstreamResponse.json().catch(() => ({}));
          } else {
            data = await upstreamResponse.text();
          }
          const inputTokens = Number((data as any)?.usage?.input_tokens ?? 0);
          const outputTokens = Number((data as any)?.usage?.output_tokens ?? 0);
          observedInputTokens = inputTokens;
          observedOutputTokens = outputTokens;
          const usageUnits = Math.max(0, inputTokens + outputTokens);
          await runtime.repos.sellerKeys.addCapacityUsage(decision.sellerKeyId, usageUnits);

          return {
            upstreamStatus: upstreamResponse.status,
            contentType: contentTypeOut,
            data,
            usageUnits,
            routeDecision: sellerRouteDecision,
            ttfbMs
          };
        }
      });

      result = {
        requestId: sellerResult.requestId,
        keyId: sellerResult.keyId,
        attemptNo: sellerResult.attemptNo,
        upstreamStatus: sellerResult.upstreamStatus,
        usageUnits: sellerResult.usageUnits ?? 0,
        contentType: sellerResult.contentType ?? 'application/json',
        data: sellerResult.data,
        routeKind: 'seller_key',
        alreadyRecorded: false,
        routeDecision: sellerResult.routeDecision,
        ttfbMs: sellerResult.ttfbMs
      };
    }

    if (!result) {
      throw new AppError('capacity_unavailable', 429, 'No provider produced a routable result');
    }
    if (res.headersSent || res.writableEnded) return;

    const latencyMs = Date.now() - startedAt;

    if (!result.alreadyRecorded) {
      await runtime.repos.routingEvents.insert({
        requestId,
        attemptNo: result.attemptNo,
        orgId,
        apiKeyId: auth.apiKeyId,
        sellerKeyId: result.keyId ?? undefined,
        provider: requestProvider,
        model: parsed.model,
        streaming: parsed.streaming,
        routeDecision: result.routeDecision ?? { reason: 'weighted_round_robin' },
        upstreamStatus: result.upstreamStatus,
        latencyMs,
        ttfbMs: result.ttfbMs ?? null
      });
      if (result.upstreamStatus >= 200 && result.upstreamStatus < 300) {
        await runtime.services.metering.recordUsage({
          requestId,
          attemptNo: result.attemptNo,
          orgId,
          apiKeyId: auth.apiKeyId,
          sellerKeyId: result.keyId ?? undefined,
          provider: requestProvider,
          model: parsed.model,
          inputTokens: observedInputTokens,
          outputTokens: observedOutputTokens,
          usageUnits: result.usageUnits ?? 0,
          retailEquivalentMinor: result.usageUnits ?? 0
        });
      }
    }

    const archiveStatus = result.upstreamStatus >= 200 && result.upstreamStatus < 300
      ? 'success'
      : 'failed';
    const archivedProvider = result.routeKind === 'token_credential'
      && typeof result.routeDecision?.provider_effective === 'string'
      ? String(result.routeDecision.provider_effective)
      : requestProvider;
    const archivedModel = result.routeKind === 'token_credential'
      && typeof result.routeDecision?.translated_model === 'string'
      ? String(result.routeDecision.translated_model)
      : parsed.model;
    await archiveProxyAttempt({
      requestId: result.requestId,
      attemptNo: result.attemptNo,
      orgId,
      apiKeyId: auth.apiKeyId,
      routeKind: result.routeKind,
      sellerKeyId: result.routeKind === 'seller_key' ? result.keyId : null,
      tokenCredentialId: result.routeKind === 'token_credential' ? result.keyId : null,
      provider: archivedProvider,
      model: archivedModel,
      streaming: parsed.streaming,
      status: archiveStatus,
      upstreamStatus: result.upstreamStatus,
      errorCode: archiveStatus === 'success' ? null : `upstream_${result.upstreamStatus}`,
      requestPath: proxiedPath,
      requestPayload: parsed.payload ?? null,
      responsePayload: result.data ?? null,
      rawResponse: result.data ?? null,
      startedAtMs: startedAt,
      correlation
    });

    if (idemStart && !idemStart.replay) {
      await commitProxyMetadataIdempotency(idemStart, result.requestId, {
        type: 'non_stream_non_replayable',
        requestId: result.requestId,
        attemptNo: result.attemptNo,
        upstreamStatus: result.upstreamStatus
      });
    }

    res.setHeader('x-request-id', requestId);
    if (result.routeKind === 'seller_key' && result.keyId) {
      res.setHeader('x-innies-upstream-key-id', result.keyId);
    }
    if (result.routeKind === 'token_credential' && result.keyId) {
      res.setHeader('x-innies-token-credential-id', result.keyId);
    }
    res.setHeader('x-innies-attempt-no', String(result.attemptNo));
    if (result.contentType) {
      res.setHeader('content-type', result.contentType);
    }

    if (typeof result.data === 'string') {
      res.status(result.upstreamStatus).send(result.data);
      return;
    }

    res.status(result.upstreamStatus).json(result.data);
  } catch (err) {
    next(err);
  }
}

router.post('/v1/proxy/*', requireApiKey(runtime.repos.apiKeys, ['buyer_proxy', 'admin']), proxyPostHandler);

export default router;
