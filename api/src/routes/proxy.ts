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
  isOpenAiOauthAccessToken,
  resolveOpenAiOauthAccountId,
  resolveOpenAiOauthClientId,
  resolveOpenAiOauthExpiresAt
} from '../utils/openaiOauth.js';

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
};

type MeteringSource = 'payload_usage' | 'stream_usage' | 'stream_estimate';
type OpenClawCorrelation = {
  openclawRunId: string;
  openclawSessionId?: string;
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
  const openclawRunId = readHeader(req, 'x-openclaw-run-id', 'openclaw-run-id', 'x-run-id')
    ?? (metadataRunId && metadataRunId.length > 0 ? metadataRunId : undefined)
    ?? `run_${requestId}`;
  const openclawSessionId = readHeader(req, 'x-openclaw-session-id', 'openclaw-session-id', 'x-session-id')
    ?? (metadataSessionId && metadataSessionId.length > 0 ? metadataSessionId : undefined);
  return { openclawRunId, openclawSessionId };
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
      streaming: parsed.stream === true,
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

  const storedPreference = input.preferredProviderSource === 'explicit' && input.preferredProvider
    ? [canonicalizeProvider(input.preferredProvider)]
    : [];
  if (storedPreference.length === 0) {
    const defaultProvider = resolveDefaultBuyerProvider();
    const deduped = Array.from(new Set([defaultProvider, requestProvider]));
    return {
      providerPlan: deduped,
      preferredProvider: deduped[0]
    };
  }

  const deduped = Array.from(new Set([...storedPreference, requestProvider, alternateProvider(storedPreference[0])]));
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

function tokenCredentialProbeIntervalHours(): number {
  const parsed = Number(process.env.TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS || 24);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 24;
}

function tokenCredentialMaxStatuses(): Set<number> {
  const raw = process.env.TOKEN_CREDENTIAL_MAX_ON_STATUSES || '401';
  const parsed = new Set<number>();
  for (const chunk of raw.split(',')) {
    const code = Number(chunk.trim());
    if (code === 401 || code === 403 || code === 429) parsed.add(code);
  }
  if (parsed.size === 0) parsed.add(401);
  return parsed;
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

function buildTokenRouteDecision(
  credential: TokenCredential,
  correlation: OpenClawCorrelation,
  providerPreference?: ProviderPreferenceMeta,
  compatTranslation?: CompatTranslationMeta
): Record<string, unknown> {
  const selectionReason = providerPreference?.selectionReason ?? 'preferred_provider_selected';
  const decision: Record<string, unknown> = {
    reason: selectionReason,
    provider_selection_reason: selectionReason,
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
  return decision;
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
  if (!tokenCredentialMaxStatuses().has(upstreamStatus)) return;

  const threshold = tokenCredentialMaxedFailureThreshold();
  const nextProbeAt = new Date(Date.now() + (tokenCredentialProbeIntervalHours() * 60 * 60 * 1000));
  const result = await runtime.repos.tokenCredentials.recordFailureAndMaybeMax({
    id: credential.id,
    statusCode: upstreamStatus,
    threshold,
    nextProbeAt,
    reason: `upstream_${upstreamStatus}_consecutive_failure`
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

  return {
    ...(payload as Record<string, unknown>),
    // Codex ChatGPT backend rejects persisted Responses requests.
    store: false,
    ...(streaming ? { stream: true } : {})
  };
}

async function attemptOpenAiOauthRefresh(credential: TokenCredential): Promise<TokenCredential | null> {
  if (!credential.refreshToken) return null;
  if (!isOpenAiOauthAccessToken(credential.accessToken)) return null;

  const clientId = resolveOpenAiOauthClientId(credential.accessToken);
  if (!clientId) return null;

  const refreshUrl = process.env.OPENAI_OAUTH_TOKEN_ENDPOINT || 'https://auth.openai.com/oauth/token';
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: credential.refreshToken
  });

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: form.toString()
  }).catch(() => null);

  if (!response?.ok) return null;

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!accessToken) return null;

  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.trim().length > 0
    ? payload.refresh_token
    : credential.refreshToken;
  const expiresAt = typeof payload.expires_at === 'string'
    ? new Date(payload.expires_at)
    : (typeof payload.expires_in === 'number'
      ? new Date(Date.now() + (payload.expires_in * 1000))
      : (resolveOpenAiOauthExpiresAt(accessToken) ?? credential.expiresAt));

  return runtime.repos.tokenCredentials.refreshInPlace({
    id: credential.id,
    accessToken,
    refreshToken,
    expiresAt
  });
}

async function attemptCredentialRefresh(credential: TokenCredential): Promise<TokenCredential | null> {
  const openAiOauthCredential = await attemptOpenAiOauthRefresh(credential);
  if (openAiOauthCredential) return openAiOauthCredential;

  if (!credential.refreshToken) return null;
  const refreshUrl = process.env.TOKEN_REFRESH_ENDPOINT;
  if (!refreshUrl) return null;

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: credential.provider,
      orgId: credential.orgId,
      refreshToken: credential.refreshToken
    })
  }).catch(() => null);

  if (!response?.ok) return null;
  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!accessToken) return null;
  const refreshToken = typeof payload.refresh_token === 'string'
    ? payload.refresh_token
    : credential.refreshToken;
  const expiresAt = typeof payload.expires_at === 'string'
    ? new Date(payload.expires_at)
    : (typeof payload.expires_in === 'number' ? new Date(Date.now() + (payload.expires_in * 1000)) : credential.expiresAt);

  return runtime.repos.tokenCredentials.refreshInPlace({
    id: credential.id,
    accessToken,
    refreshToken,
    expiresAt
  });
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
  const credentials = orderCredentialsForRequest(
    await runtime.repos.tokenCredentials.listActiveForRouting(orgId, provider),
    requestId
  );
  if (credentials.length === 0) {
    throw new AppError('capacity_unavailable', 429, 'No eligible token credentials available', { provider, model });
  }

  let attemptNo = 0;
  let sawAuthFailure = false;
  let lastAuthStatus: number | null = null;
  let lastAuthFailure: { attemptNo: number; credentialId: string; credentialLabel?: string | null; status: number; errorType?: string; errorMessage?: string } | null = null;
  let terminalCompatError: ReturnType<typeof mapOpenAiErrorToAnthropic> | null = null;
  let terminalCompatCredentialId: string | null = null;
  let terminalCompatAttemptNo = 0;
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
      const upstreamPayload = normalizeTokenModeUpstreamPayload({
        provider,
        credential,
        proxiedPath,
        payload: compat.payload ?? {},
        streaming: false
      });

      const logAttemptFailure = async (failure: AttemptFailure) => {
        await runtime.repos.routingEvents.insert({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          provider,
          model,
          streaming: false,
          routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
          upstreamStatus: failure.statusCode,
          errorCode: inferErrorCode(failure),
          latencyMs: Date.now() - startedAt
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
            routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
            upstreamStatus: status,
            errorCode: 'upstream_403_blocked_passthrough',
            latencyMs: Date.now() - startedAt
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
          const next = await attemptCredentialRefresh(credential);
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
        await logAttemptFailure({ kind: 'auth', statusCode: status, message: 'token auth failed' });
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
        if (compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const rateLimitData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
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
        await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' });
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
            routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
            upstreamStatus: status,
            errorCode: 'upstream_5xx_passthrough',
            latencyMs: Date.now() - startedAt
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

        await logAttemptFailure({ kind: 'server_error', statusCode: status, message: 'upstream server error' });
        break;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const data = contentType.includes('application/json')
        ? await upstreamResponse.json().catch(() => ({}))
        : await upstreamResponse.text();
      // Map ALL error statuses on translated paths to Anthropic-shaped error envelopes.
      const downstreamMappedError = compatTranslation && status >= 400
        ? mapOpenAiErrorToAnthropic(status, data)
        : null;
      const downstreamData = compatTranslation && status >= 200 && status < 300
        ? translateOpenAiToAnthropic({
          data,
          model: compatTranslation.originalModel
        })
        : (downstreamMappedError?.body ?? data);
      const downstreamContentType = compatTranslation ? 'application/json' : contentType;
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

      if (status >= 200 && status < 300) {
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
        routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
        upstreamStatus: status,
        latencyMs: Date.now() - startedAt
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

      return {
        requestId,
        keyId: credential.id,
        attemptNo,
        upstreamStatus: downstreamMappedError?.status ?? status,
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

  throw new AppError('capacity_unavailable', 429, 'All token credential attempts exhausted', {
    provider,
    model,
    ...(compatTerminalResult ? { compatTerminalResult } : {})
  });
}

async function executeTokenModeStreaming(input: {
  requestId: string;
  orgId: string;
  apiKeyId: string;
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
  allowCompatTerminalErrorResponse?: boolean;
}): Promise<ProxyRouteResult | null> {
  const {
    requestId,
    orgId,
    apiKeyId,
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
    allowCompatTerminalErrorResponse
  } = input;

  const credentials = orderCredentialsForRequest(
    await runtime.repos.tokenCredentials.listActiveForRouting(orgId, provider),
    requestId
  );
  if (credentials.length === 0) {
    throw new AppError('capacity_unavailable', 429, 'No eligible token credentials available', { provider, model });
  }

  let attemptNo = 0;
  let sawAuthFailure = false;
  let lastAuthStatus: number | null = null;
  let lastAuthFailure: { attemptNo: number; credentialId: string; credentialLabel?: string | null; status: number; errorType?: string; errorMessage?: string } | null = null;
  let terminalCompatError: ReturnType<typeof mapOpenAiErrorToAnthropic> | null = null;
  let terminalCompatCredentialId: string | null = null;
  let terminalCompatAttemptNo = 0;

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

      const logAttemptFailure = async (failure: AttemptFailure) => {
        await runtime.repos.routingEvents.insert({
          requestId,
          attemptNo,
          orgId,
          apiKeyId,
          sellerKeyId: undefined,
          provider,
          model,
          streaming: true,
          routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
          upstreamStatus: failure.statusCode,
          errorCode: inferErrorCode(failure),
          latencyMs: Date.now() - startedAt
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
            routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
            upstreamStatus: status,
            errorCode: 'upstream_403_blocked_passthrough',
            latencyMs: Date.now() - startedAt
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
          const next = await attemptCredentialRefresh(credential);
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
        await logAttemptFailure({ kind: 'auth', statusCode: status, message: 'token auth failed' });
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
        if (compatTranslation) {
          const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
          const rateLimitData = contentType.includes('application/json')
            ? await upstreamResponse.json().catch(() => ({}))
            : await upstreamResponse.text();
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
        await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' });
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
        await logAttemptFailure({ kind: 'server_error', statusCode: status, message: 'upstream server error' });
        break;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const isStreaming = contentType.includes('text/event-stream');
      if (!isStreaming) {
        const data = contentType.includes('application/json')
          ? await upstreamResponse.json().catch(() => ({}))
          : await upstreamResponse.text();
        // Map ALL error statuses on translated paths to Anthropic-shaped error envelopes.
        const downstreamMappedError = compatTranslation && status >= 400
          ? mapOpenAiErrorToAnthropic(status, data)
          : null;
        const downstreamData = compatTranslation && status >= 200 && status < 300
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
            routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
          upstreamStatus: status,
          errorCode: status >= 500 ? 'upstream_5xx_passthrough' : undefined,
          latencyMs: Date.now() - startedAt
        });

        // Maintain stream contract for compat callers: if client requested stream=true,
        // do not downgrade a successful response to JSON.
        if (
          status >= 200 &&
          status < 300 &&
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

          const syntheticMessage = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
          const downstreamMessage = (downstreamData && typeof downstreamData === 'object'
            ? downstreamData
            : {}) as Record<string, unknown>;
          const syntheticSummary = summarizeSyntheticContentBlocks(
            compatTranslation ? downstreamMessage : syntheticMessage
          );
          const syntheticPayload = `: keepalive\n\n${buildSyntheticAnthropicSse(
            compatTranslation ? downstreamMessage : syntheticMessage,
            compatTranslation ? compatTranslation.originalModel : model
          )}`;
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
                note: `metering_source=${meteringSource} stream_mode=synthetic_bridge`
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
            synthetic_stream_bridge: true
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
            stream_mode: 'synthetic_bridge',
            synthetic_stream_bridge: true,
            metering_source: meteringSource,
            pre_upstream_ms: dispatchStartedAt - attemptStartedAt,
            upstream_ttfb_ms: upstreamHeadersAt - dispatchStartedAt,
            bridge_build_ms: firstDownstreamWriteAt ? (firstDownstreamWriteAt - upstreamHeadersAt) : null,
            synthetic_content_block_count: syntheticSummary.count,
            synthetic_content_block_types: syntheticSummary.types,
            post_stream_write_ms: firstDownstreamWriteAt && streamEndedAt
              ? Math.max(0, streamEndedAt - firstDownstreamWriteAt)
              : null
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

        return {
          requestId,
          keyId: credential.id,
          attemptNo,
          upstreamStatus: downstreamMappedError?.status ?? status,
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
        await logAttemptFailure({ kind: 'network', message: 'upstream stream missing body' });
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
        routeDecision: buildTokenRouteDecision(credential, correlation, providerPreference, compatTranslation),
        upstreamStatus: status,
        latencyMs: Date.now() - startedAt
      });

      if (status >= 200 && status < 300) {
        await recordTokenCredentialOutcome({
          credential,
          requestId,
          attemptNo,
          provider,
          model,
          upstreamStatus: status
        });
      }

      let totalBytes = 0;
      let totalChunks = 0;
      let sampled = '';
      let firstByteAt: number | null = null;
      let firstDownstreamWriteAt: number | null = null;
      let streamEndedAt: number | null = null;
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
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
          callback(null, chunk);
        }
      });
      try {
        if (compatTranslation) {
          await pipeline(
            Readable.fromWeb(upstreamResponse.body as any),
            new OpenAiToAnthropicStreamTransform({
              model: compatTranslation.originalModel
            }),
            meter,
            res as any
          );
        } else {
          await pipeline(Readable.fromWeb(upstreamResponse.body as any), meter, res as any);
        }
      } catch {
        // Client disconnects are expected sometimes; continue with best-effort metering.
      } finally {
        clearInterval(keepaliveTimer);
        streamEndedAt = Date.now();
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

      try {
        if (idempotencySession && !idempotencySession.replay) {
          await commitProxyMetadataIdempotency(
            idempotencySession,
            requestId,
            { type: 'stream_non_replayable', requestId, usageUnits }
          );
        }

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

  throw new AppError('capacity_unavailable', 429, 'All token credential attempts exhausted', {
    provider,
    model,
    ...(compatTerminalResult ? { compatTerminalResult } : {})
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
    if (tokenModeEnabled) {
      const pinSelectionReason = (readProviderPinSignal(req) || isClaudeCliPinnedRequest(req, proxiedPath))
        ? 'cli_provider_pinned'
        : null;
      const {
        providerPlan,
        preferredProvider,
        pinSelectionReason: effectivePinSelectionReason
      } = parseProviderPreferencePlan({
        preferredProvider: auth.preferredProvider,
        preferredProviderSource: auth.preferredProviderSource,
        requestProvider,
        pinSelectionReason
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
              allowCompatTerminalErrorResponse: provider === providerPlan[providerPlan.length - 1]
            });
            if (streamedResult === null || res.headersSent || res.writableEnded) return;
            result = streamedResult;
          } else {
            result = await executeTokenModeNonStreaming({
              requestId,
              orgId,
              apiKeyId: auth.apiKeyId,
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
          const logAttemptFailure = async (failure: AttemptFailure) => {
            await runtime.repos.routingEvents.insert({
              requestId,
              attemptNo: decision.attemptNo,
              orgId,
              apiKeyId: auth.apiKeyId,
              sellerKeyId: decision.sellerKeyId,
              provider: requestProvider,
              model: parsed.model,
              streaming: parsed.streaming,
              routeDecision: { reason: decision.reason },
              upstreamStatus: failure.statusCode,
              errorCode: inferErrorCode(failure),
              latencyMs: Date.now() - startedAt
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

          if (upstreamResponse.status === 429) {
            await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' });
            throw Object.assign(new Error('rate limited'), { kind: 'rate_limited', statusCode: 429 });
          }

          if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
            await logAttemptFailure({ kind: 'auth', statusCode: upstreamResponse.status, message: 'auth failed' });
            throw Object.assign(new Error('auth failed'), { kind: 'auth', keySpecific: true, statusCode: upstreamResponse.status });
          }

          if (upstreamResponse.status >= 500) {
            await logAttemptFailure({ kind: 'server_error', statusCode: upstreamResponse.status, message: 'upstream server error' });
            throw Object.assign(new Error('upstream server error'), { kind: 'server_error', statusCode: upstreamResponse.status });
          }

          const contentType = upstreamResponse.headers.get('content-type') ?? '';
          const isStreaming = contentType.includes('text/event-stream');

          if (parsed.streaming && isStreaming) {
            res.setHeader('x-request-id', requestId);
            res.setHeader('content-type', contentType);
            res.status(upstreamResponse.status);

            if (!upstreamResponse.body) {
              await logAttemptFailure({ kind: 'network', message: 'upstream stream missing body' });
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
              routeDecision: { reason: decision.reason },
              upstreamStatus: upstreamResponse.status,
              latencyMs: Date.now() - startedAt
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
              usageUnits
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
            usageUnits
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
        alreadyRecorded: false
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
        routeDecision: { reason: 'weighted_round_robin' },
        upstreamStatus: result.upstreamStatus,
        latencyMs
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
