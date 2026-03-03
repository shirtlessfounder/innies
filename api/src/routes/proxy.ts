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

const router = Router();

const proxyRequestSchema = z.object({
  provider: z.string().min(1).default('anthropic'),
  model: z.string().min(1).default('claude-code'),
  streaming: z.boolean().default(true),
  payload: z.unknown().optional(),
});

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

function extractProxyPath(originalUrl: string): string {
  const marker = '/v1/proxy/';
  const idx = originalUrl.indexOf(marker);
  if (idx < 0) return '/';
  const rest = originalUrl.slice(idx + marker.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

function upstreamBaseUrl(provider: string): string {
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_UPSTREAM_BASE_URL || 'https://api.anthropic.com';
  }

  throw new AppError('model_invalid', 400, `Unsupported provider: ${provider}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isAnthropicOauthToken(credential: TokenCredential, provider: string): boolean {
  return provider === 'anthropic'
    && credential.authScheme === 'bearer'
    && credential.accessToken.includes('sk-ant-oat');
}

function buildTokenModeUpstreamHeaders(input: {
  requestId: string;
  anthropicVersion: string;
  provider: string;
  credential: TokenCredential;
}): Record<string, string> {
  const { requestId, anthropicVersion, provider, credential } = input;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': requestId,
    'anthropic-version': anthropicVersion,
    ...mapAuthHeader(credential.authScheme, credential.accessToken)
  };

  if (isAnthropicOauthToken(credential, provider)) {
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETAS.join(',');
  }

  return headers;
}

function mapAuthHeader(authScheme: TokenCredential['authScheme'], accessToken: string): Record<string, string> {
  if (authScheme === 'bearer') {
    return { authorization: `Bearer ${accessToken}` };
  }
  return { 'x-api-key': accessToken };
}

async function attemptCredentialRefresh(credential: TokenCredential): Promise<TokenCredential | null> {
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

function sendProxyReplayNotSupported(res: Response, requestId: string): void {
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-idempotent-replay', 'true');
  res.status(409).json({
    code: 'proxy_replay_not_supported',
    message: 'Proxy requests are metadata-only idempotent in C1. Retry with a new Idempotency-Key.'
  });
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
  provider: string;
  model: string;
  payload: unknown;
  proxiedPath: string;
  anthropicVersion: string;
  startedAt: number;
}): Promise<ProxyRouteResult> {
  const {
    requestId,
    orgId,
    apiKeyId,
    provider,
    model,
    payload,
    proxiedPath,
    anthropicVersion,
    startedAt
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
  for (const initialCredential of credentials) {
    attemptNo += 1;
    let credential = initialCredential;
    let refreshed = false;

    while (true) {
      const baseUrl = upstreamBaseUrl(provider);
      const targetUrl = new URL(proxiedPath, baseUrl);
      const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

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
          routeDecision: {
            reason: 'token_mode_round_robin',
            tokenCredentialId: credential.id,
            tokenAuthScheme: credential.authScheme
          },
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
          provider,
          credential
        }),
        body: JSON.stringify(payload ?? {}),
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
      if (status === 401 || status === 403) {
        if (!refreshed) {
          const next = await attemptCredentialRefresh(credential);
          refreshed = true;
          if (next) {
            credential = next;
            continue;
          }
          await runtime.repos.tokenCredentials.markExpired(credential.id);
        }
        sawAuthFailure = true;
        lastAuthStatus = status;
        await logAttemptFailure({ kind: 'auth', statusCode: status, message: 'token auth failed' });
        break;
      }

      if (status === 429) {
        await logAttemptFailure({ kind: 'rate_limited', statusCode: 429, message: 'rate limited' });
        const backoffMs = 200 * (2 ** (attemptNo - 1)) + Math.floor(Math.random() * 100);
        await sleep(backoffMs);
        break;
      }

      if (status >= 500) {
        await logAttemptFailure({ kind: 'server_error', statusCode: status, message: 'upstream server error' });
        break;
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const data = contentType.includes('application/json')
        ? await upstreamResponse.json().catch(() => ({}))
        : await upstreamResponse.text();
      const inputTokens = Number((data as any)?.usage?.input_tokens ?? 0);
      const outputTokens = Number((data as any)?.usage?.output_tokens ?? 0);
      const usageUnits = Math.max(0, inputTokens + outputTokens);

      await runtime.repos.routingEvents.insert({
        requestId,
        attemptNo,
        orgId,
        apiKeyId,
        sellerKeyId: undefined,
        provider,
        model,
        streaming: false,
        routeDecision: {
          reason: 'token_mode_round_robin',
          tokenCredentialId: credential.id,
          tokenAuthScheme: credential.authScheme
        },
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
        upstreamStatus: status,
        usageUnits,
        contentType,
        data,
        routeKind: 'token_credential',
        alreadyRecorded: true
      };
    }
  }

  if (sawAuthFailure) {
    throw new AppError('unauthorized', 401, 'All token credentials unauthorized or expired', {
      provider,
      model,
      lastAuthStatus
    });
  }

  throw new AppError('capacity_unavailable', 429, 'All token credential attempts exhausted', { provider, model });
}

router.post('/v1/proxy/*', requireApiKey(runtime.repos.apiKeys, ['buyer_proxy', 'admin']), async (req, res, next) => {
  const startedAt = Date.now();
  let observedInputTokens = 0;
  let observedOutputTokens = 0;
  try {
    const auth = req.auth;
    if (!auth?.orgId) {
      throw new AppError('forbidden', 403, 'API key is not associated with an org');
    }
    const orgId = auth.orgId;

    const parsed = proxyRequestSchema.parse(req.body);
    const requestId = buildRequestId(req.header('x-request-id') ?? undefined);
    const idempotencyKey = readAndValidateIdempotencyKey(req.header('idempotency-key') ?? undefined);

    if (await runtime.repos.killSwitch.isDisabled('global', '*')) {
      throw new AppError('suspended', 423, 'Proxy is globally disabled');
    }

    if (await runtime.repos.killSwitch.isDisabled('org', orgId)) {
      throw new AppError('suspended', 423, 'Org is disabled');
    }

    if (await runtime.repos.killSwitch.isDisabled('model', `${parsed.provider}:${parsed.model}`)) {
      throw new AppError('suspended', 423, 'Model is disabled');
    }

    const compatible = await runtime.repos.modelCompatibility.findActive(parsed.provider, parsed.model);
    if (!compatible) {
      throw new AppError('model_invalid', 400, 'No active compatibility rule for provider/model');
    }

    if (parsed.streaming && !compatible.supports_streaming) {
      throw new AppError('model_invalid', 400, 'Streaming not supported for provider/model');
    }

    const idempotencyScope = 'proxy.v1';
    const requestHash = sha256Hex(
      stableJson({
        method: req.method,
        path: req.path,
        orgId,
        provider: parsed.provider,
        model: parsed.model,
        streaming: parsed.streaming,
        payload: parsed.payload ?? null
      })
    );

    const idemStart = await runtime.services.idempotency.start({
      scope: idempotencyScope,
      tenantScope: orgId,
      idempotencyKey,
      requestHash
    });

    if (idemStart.replay) {
      sendProxyReplayNotSupported(res, requestId);
      return;
    }

    const tokenModeEnabled = isTokenModeEnabledForOrg(orgId);
    if (isTokenModePolicyActive() && !tokenModeEnabled) {
      throw new AppError('forbidden', 403, 'Token mode not enabled for org', { orgId });
    }

    const proxiedPath = extractProxyPath(req.originalUrl);
    let result: ProxyRouteResult;
    if (tokenModeEnabled) {
      if (parsed.streaming) {
        throw new AppError('model_invalid', 400, 'Streaming token-mode validation is C1.5; C1 supports non-streaming only');
      }
      result = await executeTokenModeNonStreaming({
        requestId,
        orgId,
        apiKeyId: auth.apiKeyId,
        provider: parsed.provider,
        model: parsed.model,
        payload: parsed.payload ?? {},
        proxiedPath,
        anthropicVersion: req.header('anthropic-version') ?? '2023-06-01',
        startedAt
      });
    } else {
      const keys = await runtime.repos.sellerKeys.listActiveForRouting(parsed.provider, parsed.model, parsed.streaming);
      runtime.services.keyPool.setKeys(keys);

      const sellerResult = await runtime.services.routingService.execute({
        request: {
          requestId,
          orgId,
          provider: parsed.provider,
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
              provider: parsed.provider,
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

          const baseUrl = upstreamBaseUrl(parsed.provider);
          const targetUrl = new URL(proxiedPath, baseUrl);
          const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
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

            await commitProxyMetadataIdempotency(
              idemStart,
              requestId,
              { type: 'stream_non_replayable', requestId, usageUnits }
            );

            await runtime.repos.sellerKeys.addCapacityUsage(decision.sellerKeyId, usageUnits);
            await runtime.repos.routingEvents.insert({
              requestId,
              attemptNo: decision.attemptNo,
              orgId,
              apiKeyId: auth.apiKeyId,
              sellerKeyId: decision.sellerKeyId,
              provider: parsed.provider,
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
              provider: parsed.provider,
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

    if (res.headersSent || res.writableEnded) return;

    const latencyMs = Date.now() - startedAt;

    if (!result.alreadyRecorded) {
      await runtime.repos.routingEvents.insert({
        requestId,
        attemptNo: result.attemptNo,
        orgId,
        apiKeyId: auth.apiKeyId,
        sellerKeyId: result.keyId ?? undefined,
        provider: parsed.provider,
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
        provider: parsed.provider,
        model: parsed.model,
        inputTokens: observedInputTokens,
        outputTokens: observedOutputTokens,
        usageUnits: result.usageUnits ?? 0,
        retailEquivalentMinor: result.usageUnits ?? 0
      });
    }

    await commitProxyMetadataIdempotency(idemStart, result.requestId, {
      type: 'non_stream_non_replayable',
      requestId: result.requestId,
      attemptNo: result.attemptNo,
      upstreamStatus: result.upstreamStatus
    });

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
});

export default router;
