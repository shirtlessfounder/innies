import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { TokenCredential } from '../repos/tokenCredentialRepository.js';
import { runtime } from '../services/runtime.js';
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
import { summarizeAnthropicCompatRequestShape } from '../utils/anthropicCompatTrace.js';
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
  parkAnthropicOauthCredentialAfterUsageAuthFailure,
  providerUsageWarningReasonFromRefreshOutcome,
  readTokenCredentialRateLimitLongBackoffMinutes
} from '../services/tokenCredentialProviderUsage.js';
import { readClaudeContributionCapSnapshotState } from '../services/claudeContributionCapState.js';
import {
  attemptTokenCredentialRefresh,
  refreshAnthropicOauthUsageWithCredentialRefresh
} from '../services/tokenCredentialOauthRefresh.js';

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

function parseProviderPreferencePlan(input: {
  preferredProvider?: string | null;
  preferredProviderSource?: 'explicit' | 'default' | null;
  requestProvider: string;
  pinSelectionReason?: ProviderSelectionReason | null;
}): {
  providerPlan: string[];
  preferredProvider: string;
  pinSelectionReason?: ProviderSelectionReason;
} {
  const requestProvider = canonicalizeProvider(input.requestProvider);
  if (input.pinSelectionReason) {
    return {
      providerPlan: [requestProvider],
      preferredProvider: requestProvider,
      pinSelectionReason: input.pinSelectionReason
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

function shouldLogCompatInvalidRequestDebug(input: {
  strictUpstreamPassthrough?: boolean;
  provider: string;
  proxiedPath: string;
  upstreamStatus: number;
  errorType?: string;
}): boolean {
  return Boolean(
    input.strictUpstreamPassthrough
    && canonicalizeProvider(input.provider) === 'anthropic'
    && input.proxiedPath.startsWith('/v1/messages')
    && input.upstreamStatus === 400
    && input.errorType === 'invalid_request_error'
  );
}

function logCompatInvalidRequestDebug(input: {
  requestId: string;
  credentialId: string;
  credentialLabel?: string | null;
  provider: string;
  model: string;
  proxiedPath: string;
  anthropicVersion: string;
  anthropicBeta?: string;
  upstreamStatus: number;
  upstreamErrorType?: string;
  upstreamErrorMessage?: string;
  payload: unknown;
  stream: boolean;
}): void {
  console.warn('[compat-invalid-request-debug]', {
    request_id: input.requestId,
    credential_id: input.credentialId,
    credential_label: input.credentialLabel ?? null,
    provider: input.provider,
    model: input.model,
    proxied_path: input.proxiedPath,
    anthropic_version: input.anthropicVersion,
    anthropic_beta: input.anthropicBeta ?? null,
    upstream_status: input.upstreamStatus,
    upstream_error_type: input.upstreamErrorType ?? null,
    upstream_error_message: input.upstreamErrorMessage ?? null,
    request_shape: summarizeAnthropicCompatRequestShape(input.payload, input.stream, {
      includeMessageTrace: true,
      tailMessages: 12
    })
  });
}

function logCompatLocalValidationFailure(input: {
  requestId: string;
  provider: string;
  model: string;
  proxiedPath: string;
  anthropicVersion: string;
  anthropicBeta?: string;
  validationMessage: string;
  validationDetails?: unknown;
  payload: unknown;
  stream: boolean;
}): void {
  console.warn('[compat-local-validation-failed]', {
    request_id: input.requestId,
    provider: input.provider,
    model: input.model,
    proxied_path: input.proxiedPath,
    anthropic_version: input.anthropicVersion,
    anthropic_beta: input.anthropicBeta ?? null,
    validation_message: input.validationMessage,
    validation_details: input.validationDetails ?? null,
    request_shape: summarizeAnthropicCompatRequestShape(input.payload, input.stream, {
      includeMessageTrace: true,
      tailMessages: 12
    })
  });
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
  providerUsageMeta?: Record<string, unknown>
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
  return decision;
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
}> {
  const seededCredentials = orderCredentialsForRequest(
    await runtime.repos.tokenCredentials.listActiveForRouting(input.orgId, input.provider),
    input.requestId
  );
  const buyerLabelMatchedCredentialId = canonicalizeProvider(input.provider) === 'anthropic'
    ? findUniqueBuyerLabelMatchedCredentialId(seededCredentials, input.buyerKeyLabel)
    : null;
  const orderedCredentials = seededCredentials;

  const providerUsageRouteMeta = new Map<string, Record<string, unknown>>();
  if (canonicalizeProvider(input.provider) !== 'anthropic' || orderedCredentials.length === 0) {
    return {
      credentials: orderedCredentials,
      providerUsageRouteMeta,
      providerUsageExcludedReasonCounts: {}
    };
  }

  const snapshots = await runtime.repos.tokenCredentialProviderUsage.listByTokenCredentialIds(
    orderedCredentials.map((credential) => credential.id)
  );
  const snapshotsByCredentialId = new Map(snapshots.map((snapshot) => [snapshot.tokenCredentialId, snapshot]));
  const eligibleCredentials: TokenCredential[] = [];
  const providerUsageExcludedReasonCounts: Record<string, number> = {};
  const rateLimitEscalationThreshold = tokenCredentialRateLimitThreshold();

  for (const credential of orderedCredentials) {
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
      providerUsageExcludedReasonCounts[reason] = (providerUsageExcludedReasonCounts[reason] ?? 0) + 1;
      continue;
    }

    if (repeated429HoldActive) {
      providerUsageExcludedReasonCounts[CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON] = (
        providerUsageExcludedReasonCounts[CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON] ?? 0
      ) + 1;
      continue;
    }

    eligibleCredentials.push(credential);
  }

  return {
    credentials: eligibleCredentials,
    providerUsageRouteMeta,
    providerUsageExcludedReasonCounts
  };
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

function assertCompatAnthropicMessageHistorySupported(input: {
  provider: string;
  proxiedPath: string;
  strictUpstreamPassthrough: boolean;
  payload: unknown;
}): void {
  if (!input.strictUpstreamPassthrough) return;
  if (canonicalizeProvider(input.provider) !== 'anthropic') return;
  if (!input.proxiedPath.startsWith('/v1/messages')) return;
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) return;

  const payload = input.payload as Record<string, unknown>;
  const thinking = payload.thinking && typeof payload.thinking === 'object' && !Array.isArray(payload.thinking)
    ? payload.thinking as Record<string, unknown>
    : null;
  const thinkingType = typeof thinking?.type === 'string' ? String(thinking.type) : null;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  let pendingToolUseIds: string[] | null = null;
  let pendingToolUseMessageIndex: number | null = null;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const rawMessage = messages[messageIndex];
    const message = rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
      ? rawMessage as Record<string, unknown>
      : null;
    const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    let sawNonToolResultBlock = false;
    let sawToolResultAfterNonToolResult = false;
    let missingToolResultId = false;
    const leadingToolResultIds: string[] = [];

    let missingToolUseId = false;
    let assistantHasThinkingBlock = false;
    let assistantHasUnsignedThinkingBlock = false;
    const assistantToolUseIds: string[] = [];

    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
        if (role === 'user') sawNonToolResultBlock = true;
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      const blockType = typeof block.type === 'string' ? String(block.type) : null;

      if (role === 'user') {
        if (blockType === 'tool_result') {
          if (sawNonToolResultBlock) {
            sawToolResultAfterNonToolResult = true;
          }
          const toolUseId = typeof block.tool_use_id === 'string' && block.tool_use_id.trim().length > 0
            ? block.tool_use_id.trim()
            : null;
          if (!toolUseId) {
            missingToolResultId = true;
          } else if (!sawNonToolResultBlock) {
            leadingToolResultIds.push(toolUseId);
          }
          continue;
        }
        sawNonToolResultBlock = true;
        continue;
      }

      if (role !== 'assistant' || !blockType) continue;
      if (blockType === 'thinking') {
        assistantHasThinkingBlock = true;
        const signature = typeof block.signature === 'string' ? block.signature.trim() : '';
        if (signature.length === 0) assistantHasUnsignedThinkingBlock = true;
        continue;
      }
      if (blockType !== 'tool_use') continue;

      const toolUseId = typeof block.id === 'string' && block.id.trim().length > 0
        ? block.id.trim()
        : null;
      if (!toolUseId) {
        missingToolUseId = true;
        continue;
      }
      assistantToolUseIds.push(toolUseId);
    }

    if (missingToolResultId) {
      throw new AppError(
        'invalid_request',
        400,
        'tool_result blocks require a non-empty tool_use_id',
        { messageIndex }
      );
    }
    if (missingToolUseId) {
      throw new AppError(
        'invalid_request',
        400,
        'assistant tool_use blocks require a non-empty id',
        { messageIndex }
      );
    }
    if (sawToolResultAfterNonToolResult) {
      throw new AppError(
        'invalid_request',
        400,
        'tool_result blocks must come first in each user message content array',
        { messageIndex }
      );
    }

    if (pendingToolUseIds) {
      const expectedToolUseIds = pendingToolUseIds;
      if (role !== 'user') {
        throw new AppError(
          'invalid_request',
          400,
          'tool_result blocks must immediately follow the prior assistant tool_use message',
          { messageIndex, pendingToolUseIds: expectedToolUseIds, pendingToolUseMessageIndex }
        );
      }
      if (leadingToolResultIds.length === 0) {
        throw new AppError(
          'invalid_request',
          400,
          'tool_result blocks must immediately follow the prior assistant tool_use message',
          { messageIndex, pendingToolUseIds: expectedToolUseIds, pendingToolUseMessageIndex }
        );
      }

      const missingToolUseIds = expectedToolUseIds.filter((id) => !leadingToolResultIds.includes(id));
      const unexpectedToolUseIds = leadingToolResultIds.filter((id) => !expectedToolUseIds.includes(id));
      if (missingToolUseIds.length > 0 || unexpectedToolUseIds.length > 0) {
        throw new AppError(
          'invalid_request',
          400,
          'tool_result blocks must immediately follow the prior assistant tool_use message and match its tool_use ids',
          {
            messageIndex,
            pendingToolUseIds: expectedToolUseIds,
            pendingToolUseMessageIndex,
            leadingToolResultIds,
            missingToolUseIds,
            unexpectedToolUseIds
          }
        );
      }

      pendingToolUseIds = null;
      pendingToolUseMessageIndex = null;
    } else if (role === 'user' && leadingToolResultIds.length > 0) {
      throw new AppError(
        'invalid_request',
        400,
        'tool_result blocks must immediately follow a prior assistant tool_use message',
        { messageIndex, leadingToolResultIds }
      );
    }

    if (assistantToolUseIds.length > 0) {
      if (
        (thinkingType === 'enabled' || thinkingType === 'adaptive')
        && assistantHasThinkingBlock
        && assistantHasUnsignedThinkingBlock
      ) {
        throw new AppError(
          'invalid_request',
          400,
          `assistant thinking blocks preserved with thinking.type="${thinkingType}" must include signature`,
          { messageIndex, thinkingType }
        );
      }
      pendingToolUseIds = assistantToolUseIds;
      pendingToolUseMessageIndex = messageIndex;
    }
  }

  if (pendingToolUseIds) {
    throw new AppError(
      'invalid_request',
      400,
      'tool_result blocks must immediately follow the prior assistant tool_use message',
      { pendingToolUseIds, pendingToolUseMessageIndex }
    );
  }
}

function assertCompatAnthropicThinkingPayloadSupported(input: {
  provider: string;
  proxiedPath: string;
  strictUpstreamPassthrough: boolean;
  payload: unknown;
}): void {
  if (!input.strictUpstreamPassthrough) return;
  if (canonicalizeProvider(input.provider) !== 'anthropic') return;
  if (!input.proxiedPath.startsWith('/v1/messages')) return;
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) return;

  const payload = input.payload as Record<string, unknown>;
  const thinking = payload.thinking && typeof payload.thinking === 'object' && !Array.isArray(payload.thinking)
    ? payload.thinking as Record<string, unknown>
    : null;
  const thinkingType = typeof thinking?.type === 'string' ? String(thinking.type) : null;
  if (thinkingType !== 'enabled' && thinkingType !== 'adaptive') return;

  const toolChoice = payload.tool_choice;
  const toolChoiceType = typeof toolChoice === 'string'
    ? toolChoice
    : (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice) && typeof (toolChoice as Record<string, unknown>).type === 'string'
        ? String((toolChoice as Record<string, unknown>).type)
        : null);
  if (toolChoiceType === 'any' || toolChoiceType === 'tool') {
    throw new AppError(
      'invalid_request',
      400,
      `thinking.type="${thinkingType}" only supports tool_choice "auto" or "none"`,
      { thinkingType, toolChoiceType }
    );
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const lastMessage = messages.length > 0 && messages[messages.length - 1] && typeof messages[messages.length - 1] === 'object' && !Array.isArray(messages[messages.length - 1])
    ? messages[messages.length - 1] as Record<string, unknown>
    : null;
  const lastMessageRole = typeof lastMessage?.role === 'string' ? lastMessage.role.trim().toLowerCase() : null;
  if (lastMessageRole === 'assistant') {
    throw new AppError(
      'invalid_request',
      400,
      `assistant prefill is not supported when thinking.type="${thinkingType}"; final message role must be "user"`,
      { thinkingType, lastMessageRole }
    );
  }
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

function normalizeTokenModeUpstreamPayload(input: {
  provider: string;
  credential: TokenCredential;
  proxiedPath: string;
  payload: unknown;
  streaming?: boolean;
}): unknown {
  const { provider, credential, proxiedPath, payload, streaming } = input;
  if (!isOpenAiOauthToken(credential, provider)) return payload;

  const parsed = parseRelativeProxyUrl(proxiedPath);
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

function buildSyntheticAnthropicStreamFailureSse(input: {
  id?: string;
  model: string;
  message: string;
}): string {
  const id = input.id ?? `msg_${Date.now()}`;
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: `[Innies stream error: ${input.message}]`
      }
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 }
    })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join('');
}

function hasTerminalAnthropicStreamEvent(raw: string): boolean {
  const normalized = raw.toLowerCase();
  return normalized.includes('event: message_stop') || normalized.includes('"type":"message_stop"');
}

function isDownstreamClientDisconnect(res: Response, error: unknown): boolean {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : null;
  if ((res as any).destroyed || (res as any).writableEnded) return true;
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'DOWNSTREAM_CLOSED';
}

type StreamTerminalStatus = 'completed' | 'incomplete' | 'failed' | 'missing';

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
  if (raw.includes('[Translation error:')) return 'failed';
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
  anthropicVersion: string;
  anthropicBeta?: string;
  startedAt: number;
  strictUpstreamPassthrough?: boolean;
  providerPreference?: ProviderPreferenceMeta;
  compatTranslation?: CompatTranslationMeta;
  allowCompatTerminalErrorResponse?: boolean;
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
    anthropicVersion,
    anthropicBeta,
    startedAt,
    strictUpstreamPassthrough,
    providerPreference,
    compatTranslation,
    allowCompatTerminalErrorResponse
  } = input;
  const {
    credentials,
    providerUsageRouteMeta,
    providerUsageExcludedReasonCounts
  } = await resolveEligibleTokenCredentials({
    orgId,
    provider,
    requestId,
    buyerKeyLabel
  });
  if (credentials.length === 0) {
    throw new AppError('capacity_unavailable', 429, 'No eligible token credentials available', {
      provider,
      model,
      providerUsageExcludedReasonCounts: Object.keys(providerUsageExcludedReasonCounts).length > 0
        ? providerUsageExcludedReasonCounts
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
  let terminalStrictPassthroughStatus: number | null = null;
  let terminalStrictPassthroughContentType: string | null = null;
  let terminalStrictPassthroughData: unknown = null;
  let terminalStrictPassthroughCredentialId: string | null = null;
  let terminalStrictPassthroughAttemptNo = 0;
  for (const initialCredential of credentials) {
    attemptNo += 1;
    let credential = initialCredential;
    let refreshed = false;
    let compat = createCompatNormalizationState(payload, anthropicBeta);

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

      const logAttemptFailure = async (failure: AttemptFailure, ttfb?: number | null) => {
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
          upstreamStatus: failure.statusCode,
          errorCode: inferErrorCode(failure),
          latencyMs: Date.now() - startedAt,
          ttfbMs: ttfb ?? null
        });
      };

      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: buildTokenModeUpstreamHeaders({
          requestId,
          anthropicVersion,
          anthropicBeta: compat.anthropicBeta,
          provider,
          credential,
          skipOauthDefaultBetas: compat.blockedRetryApplied
        }),
        body: JSON.stringify(upstreamPayload),
        signal: controller.signal
      })
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : 'network error';
          await logAttemptFailure({ kind: 'network', message });
          return null;
        })
        .finally(() => clearTimeout(timer));

      if (!upstreamResponse) break;

      const status = upstreamResponse.status;
      const upstreamHeadersAt = Date.now();
      const ttfbMs = Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt));
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
        break;
      }

      if (status >= 500) {
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

          terminalStrictPassthroughStatus = status;
          terminalStrictPassthroughContentType = contentType;
          terminalStrictPassthroughData = data;
          terminalStrictPassthroughCredentialId = credential.id;
          terminalStrictPassthroughAttemptNo = attemptNo;
          // This branch already recorded the passthrough failure explicitly above.
          break;
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

        await logAttemptFailure({ kind: 'server_error', statusCode: status, message: 'upstream server error' }, ttfbMs);
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
        if (shouldLogCompatInvalidRequestDebug({
          strictUpstreamPassthrough,
          provider,
          proxiedPath,
          upstreamStatus: status,
          errorType
        })) {
          logCompatInvalidRequestDebug({
            requestId,
            credentialId: credential.id,
            credentialLabel: credential.debugLabel,
            provider,
            model,
            proxiedPath,
            anthropicVersion,
            anthropicBeta: compat.anthropicBeta,
            upstreamStatus: status,
            upstreamErrorType: errorType,
            upstreamErrorMessage: errorMessage,
            payload: compat.payload,
            stream: false
          });
        }
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
          providerUsageRouteMeta.get(credential.id)
        ),
        upstreamStatus: status,
        latencyMs: Date.now() - startedAt,
        ttfbMs
      });
      await runtime.services.metering.recordUsage({
        requestId,
        attemptNo,
        orgId,
        apiKeyId,
        sellerKeyId: undefined,
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
        });
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

  const strictPassthroughResult = terminalStrictPassthroughStatus != null
    ? {
      requestId,
      keyId: terminalStrictPassthroughCredentialId,
      attemptNo: terminalStrictPassthroughAttemptNo,
      upstreamStatus: terminalStrictPassthroughStatus,
      usageUnits: 0,
      contentType: terminalStrictPassthroughContentType!,
      data: terminalStrictPassthroughData,
      routeKind: 'token_credential' as const,
      alreadyRecorded: true
    }
    : null;

  if (allowCompatTerminalErrorResponse && strictPassthroughResult) {
    return strictPassthroughResult;
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
        ...(compatTerminalResult ? { compatTerminalResult } : {}),
        ...(strictPassthroughResult ? { compatTerminalResult: strictPassthroughResult } : {})
      });
  }

  throw new AppError('capacity_unavailable', 429, 'All token credential attempts exhausted', {
    provider,
    model,
    ...(compatTerminalResult ? { compatTerminalResult } : {}),
    ...(strictPassthroughResult ? { compatTerminalResult: strictPassthroughResult } : {})
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
    anthropicVersion,
    anthropicBeta,
    startedAt,
    res,
    idempotencySession,
    strictUpstreamPassthrough,
    providerPreference,
    compatTranslation,
    compatMode: compatModeFlag,
    allowCompatTerminalErrorResponse
  } = input;

  const {
    credentials,
    providerUsageRouteMeta,
    providerUsageExcludedReasonCounts
  } = await resolveEligibleTokenCredentials({
    orgId,
    provider,
    requestId,
    buyerKeyLabel
  });
  if (credentials.length === 0) {
    throw new AppError('capacity_unavailable', 429, 'No eligible token credentials available', {
      provider,
      model,
      providerUsageExcludedReasonCounts: Object.keys(providerUsageExcludedReasonCounts).length > 0
        ? providerUsageExcludedReasonCounts
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
  let terminalStrictPassthroughStatus: number | null = null;
  let terminalStrictPassthroughContentType: string | null = null;
  let terminalStrictPassthroughData: unknown = null;
  let terminalStrictPassthroughCredentialId: string | null = null;
  let terminalStrictPassthroughAttemptNo = 0;

  for (const initialCredential of credentials) {
    attemptNo += 1;
    let credential = initialCredential;
    let refreshed = false;
    let compat = createCompatNormalizationState(payload, anthropicBeta);

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
      const dispatchStartedAt = Date.now();

      const logAttemptFailure = async (failure: AttemptFailure, ttfb?: number | null) => {
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

      if (!upstreamResponse) break;

      const status = upstreamResponse.status;
      const upstreamHeadersAt = Date.now();
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
        break;
      }

      if (status >= 500 && !strictUpstreamPassthrough) {
        if (compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const upstreamErrorData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
          terminalCompatError = mapOpenAiErrorToAnthropic(status, upstreamErrorData);
          terminalCompatCredentialId = credential.id;
          terminalCompatAttemptNo = attemptNo;
        }
        await logAttemptFailure({ kind: 'server_error', statusCode: status, message: 'upstream server error' }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        break;
      }

      if (status >= 500 && strictUpstreamPassthrough) {
        const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
        const data = contentType.includes('application/json')
          ? await upstreamResponse.json().catch(() => ({}))
          : await upstreamResponse.text();
        terminalStrictPassthroughStatus = status;
        terminalStrictPassthroughContentType = contentType;
        terminalStrictPassthroughData = data;
        terminalStrictPassthroughCredentialId = credential.id;
        terminalStrictPassthroughAttemptNo = attemptNo;
        await logAttemptFailure({ kind: 'server_error', statusCode: status, message: 'upstream server error' }, Math.max(0, Math.round(upstreamHeadersAt - dispatchStartedAt)));
        break;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const isStreaming = contentType.includes('text/event-stream');
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
          if (shouldLogCompatInvalidRequestDebug({
            strictUpstreamPassthrough,
            provider,
            proxiedPath,
            upstreamStatus: status,
            errorType
          })) {
            logCompatInvalidRequestDebug({
              requestId,
              credentialId: credential.id,
              credentialLabel: credential.debugLabel,
              provider,
              model,
              proxiedPath,
              anthropicVersion,
              anthropicBeta: compat.anthropicBeta,
              upstreamStatus: status,
              upstreamErrorType: errorType,
              upstreamErrorMessage: errorMessage,
              payload: compat.payload,
              stream: true
            });
          }
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
              providerUsageRouteMeta.get(credential.id)
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
                  });
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
                });
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
      res.setHeader('content-type', compatTranslation ? 'text/event-stream; charset=utf-8' : contentType);
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
          providerUsageRouteMeta.get(credential.id)
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
                first_byte_ms: firstByteAt - startedAt
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

      if (streamFailureCode) {
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
            });
          }

          await runtime.services.metering.recordUsage({
            requestId,
            attemptNo,
            orgId,
            apiKeyId,
            sellerKeyId: undefined,
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

  const strictPassthroughResult = terminalStrictPassthroughStatus != null
    ? {
      requestId,
      keyId: terminalStrictPassthroughCredentialId,
      attemptNo: terminalStrictPassthroughAttemptNo,
      upstreamStatus: terminalStrictPassthroughStatus,
      usageUnits: 0,
      contentType: terminalStrictPassthroughContentType!,
      data: terminalStrictPassthroughData,
      routeKind: 'token_credential' as const,
      alreadyRecorded: true
    }
    : null;

  if (allowCompatTerminalErrorResponse && strictPassthroughResult) {
    return strictPassthroughResult;
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
        ...(compatTerminalResult ? { compatTerminalResult } : {}),
        ...(strictPassthroughResult ? { compatTerminalResult: strictPassthroughResult } : {})
      });
  }

  throw new AppError('capacity_unavailable', 429, 'All token credential attempts exhausted', {
    provider,
    model,
    ...(compatTerminalResult ? { compatTerminalResult } : {}),
    ...(strictPassthroughResult ? { compatTerminalResult: strictPassthroughResult } : {})
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
    if (tokenModeEnabled) {
      const {
        providerPlan,
        preferredProvider,
        pinSelectionReason: effectivePinSelectionReason
      } = parseProviderPreferencePlan({
        preferredProvider: auth.preferredProvider,
        preferredProviderSource: auth.preferredProviderSource,
        requestProvider,
        pinSelectionReason: requestPinSelectionReason
      });

      let previousProvider: string | undefined;
      let previousReason: string | undefined;
      let terminalError: unknown = null;
      let deferredCompatTerminalResult: ProxyRouteResult | null = null;

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
          try {
            assertCompatAnthropicMessageHistorySupported({
              provider: upstreamRequest.provider,
              proxiedPath: upstreamRequest.proxiedPath,
              strictUpstreamPassthrough: upstreamRequest.strictUpstreamPassthrough,
              payload: upstreamRequest.payload
            });
            assertCompatAnthropicThinkingPayloadSupported({
              provider: upstreamRequest.provider,
              proxiedPath: upstreamRequest.proxiedPath,
              strictUpstreamPassthrough: upstreamRequest.strictUpstreamPassthrough,
              payload: upstreamRequest.payload
            });
          } catch (error) {
            if (
              error instanceof AppError
              && error.status === 400
              && upstreamRequest.strictUpstreamPassthrough
              && canonicalizeProvider(upstreamRequest.provider) === 'anthropic'
              && upstreamRequest.proxiedPath.startsWith('/v1/messages')
            ) {
              logCompatLocalValidationFailure({
                requestId,
                provider: upstreamRequest.provider,
                model: upstreamRequest.model,
                proxiedPath: upstreamRequest.proxiedPath,
                anthropicVersion,
                anthropicBeta,
                validationMessage: error.message,
                validationDetails: error.details,
                payload: upstreamRequest.payload,
                stream: parsed.streaming
              });
            }
            throw error;
          }
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
              anthropicVersion,
              anthropicBeta,
              startedAt,
              res,
              idempotencySession: idemStart,
              strictUpstreamPassthrough: upstreamRequest.strictUpstreamPassthrough,
              providerPreference,
              compatTranslation: upstreamRequest.compatTranslation,
              compatMode,
              allowCompatTerminalErrorResponse: provider === providerPlan[providerPlan.length - 1]
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
              anthropicVersion,
              anthropicBeta,
              startedAt,
              strictUpstreamPassthrough: upstreamRequest.strictUpstreamPassthrough,
              providerPreference,
              compatTranslation: upstreamRequest.compatTranslation,
              allowCompatTerminalErrorResponse: provider === providerPlan[providerPlan.length - 1]
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
          const logAttemptFailure = async (failure: AttemptFailure, ttfb?: number | null) => {
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

            if (idemStart && !idemStart.replay) {
              await commitProxyMetadataIdempotency(
                idemStart,
                requestId,
                { type: 'stream_non_replayable', requestId, usageUnits }
              );
            }

            await runtime.repos.sellerKeys.addCapacityUsage(decision.sellerKeyId, usageUnits);
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
