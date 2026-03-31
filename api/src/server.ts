import 'dotenv/config';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import adminRoutes from './routes/admin.js';
import adminArchiveRoutes from './routes/adminArchive.js';
import adminOrgsRouter from './routes/adminOrgs.js';
import analyticsRoutes from './routes/analytics.js';
import anthropicCompatRoutes from './routes/anthropicCompat.js';
import paymentsRoutes from './routes/payments.js';
import orgRoutes from './routes/org.js';
import pilotRoutes from './routes/pilot.js';
import proxyRoutes from './routes/proxy.js';
import sellerKeysRoutes from './routes/sellerKeys.js';
import usageRoutes from './routes/usage.js';
import { startBackgroundJobs } from './services/runtime.js';
import {
  captureCompatRawBody,
  persistCompatTraceBody,
  sanitizeTraceHeaders
} from './utils/compatTrace.js';
import { AppError } from './utils/errors.js';

export function createApp(): express.Express {
  const app = express();
  const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '20mb';
  app.use(express.json({
    limit: jsonBodyLimit,
    verify: (req, _res, buf) => {
      captureCompatRawBody({
        req: req as express.Request & { inniesRawBodyText?: string },
        captureDir: process.env.INNIES_COMPAT_CAPTURE_DIR,
        method: req.method,
        path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        body: Buffer.from(buf)
      });
      const requestPath = typeof req.url === 'string' ? req.url.split('?')[0] : undefined;
      if (
        req.method === 'POST'
        && (requestPath === '/v1/messages' || requestPath === '/v1/payments/webhooks/stripe')
      ) {
        (req as express.Request & { inniesRawBodyText?: string }).inniesRawBodyText = Buffer.from(buf).toString('utf8');
      }
    }
  }));

  app.use((req, _res, next) => {
    const rawBodyText = (req as express.Request & { inniesRawBodyText?: string }).inniesRawBodyText;
    if (req.method !== 'POST' || req.path !== '/v1/messages' || typeof rawBodyText !== 'string') {
      next();
      return;
    }

    const headers = Object.fromEntries(
      Object.entries(req.headers)
        .flatMap(([name, value]) => {
          if (typeof value === 'string') return [[name, value] as const];
          if (Array.isArray(value)) return [[name, value.join(', ')] as const];
          return [];
        })
    );
    const capture = persistCompatTraceBody({
      requestId: req.header('x-request-id') ?? 'missing-request-id',
      phase: 'ingress',
      body: rawBodyText,
      metadata: {
        method: req.method,
        path: req.path,
        headers: sanitizeTraceHeaders(headers)
      }
    });

    if (capture) {
      console.info('[compat-ingress-capture]', {
        request_id: req.header('x-request-id') ?? null,
        method: req.method,
        path: req.path,
        headers: sanitizeTraceHeaders(headers),
        body_sha256: capture.bodySha256,
        body_bytes: capture.bodyBytes,
        body_path: capture.bodyPath,
        meta_path: capture.metaPath
      });
    }

    next();
  });

  app.use((req, res, next) => {
    if (process.env.INNIES_COMPAT_TRACE !== 'true' || req.path !== '/v1/messages') {
      next();
      return;
    }

    const startedAt = Date.now();
    const headers = req.headers;
    const body = req.body as Record<string, unknown> | undefined;
    const messages = body?.messages;
    const messageCount = Array.isArray(messages) ? messages.length : 0;

    // Redacted trace for compat debugging: no auth values, no raw prompts/tool payloads.
    // eslint-disable-next-line no-console
    console.log('[/v1/messages] request', {
      method: req.method,
      path: req.path,
      requestIdHeader: headers['x-request-id'],
      contentType: headers['content-type'],
      anthropicVersion: headers['anthropic-version'],
      anthropicBeta: headers['anthropic-beta'],
      hasAuthorization: Boolean(headers.authorization),
      hasApiKey: Boolean(headers['x-api-key']),
      bodyShape: {
        model: body?.model,
        stream: body?.stream,
        hasMessages: Array.isArray(messages),
        messageCount,
        hasSystem: body?.system != null,
        hasTools: Array.isArray(body?.tools),
        hasToolChoice: body?.tool_choice != null,
        hasThinking: body?.thinking != null,
        hasMetadata: body?.metadata != null
      }
    });

    res.on('finish', () => {
      // eslint-disable-next-line no-console
      console.log('[/v1/messages] response', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        responseRequestId: res.getHeader('x-request-id'),
        responseContentType: res.getHeader('content-type'),
        attemptNo: res.getHeader('x-innies-attempt-no'),
        tokenCredentialId: res.getHeader('x-innies-token-credential-id'),
        upstreamKeyId: res.getHeader('x-innies-upstream-key-id')
      });
    });

    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(adminRoutes);
  app.use(adminArchiveRoutes);
  app.use('/v1/admin', adminOrgsRouter);
  app.use(analyticsRoutes);
  app.use(anthropicCompatRoutes);
  app.use(paymentsRoutes);
  app.use(orgRoutes);
  app.use(pilotRoutes);
  app.use(sellerKeysRoutes);
  app.use(usageRoutes);
  app.use(proxyRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ code: 'invalid_request', message: 'Invalid request', issues: err.issues });
      return;
    }

    if (err instanceof AppError) {
      // On compat-translated requests, format errors as Anthropic-shaped envelopes
      // so OpenClaw/clients never see innies-native error shapes.
      if (((_req as any).inniesCompatMode)) {
        const anthropicErrorType =
          err.status === 401 ? 'authentication_error'
          : err.status === 403 ? 'permission_error'
          : err.status === 429 ? 'rate_limit_error'
          : err.status === 404 ? 'not_found_error'
          : err.status >= 400 && err.status < 500 ? 'invalid_request_error'
          : 'api_error';
        const anthropicStatus = err.status >= 500 ? 500 : err.status;
        res.status(anthropicStatus).json({
          type: 'error',
          error: { type: anthropicErrorType, message: err.message }
        });
        return;
      }
      res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
      return;
    }

    const message = err instanceof Error ? err.message : 'Unexpected error';
    if (((_req as any).inniesCompatMode)) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message }
      });
      return;
    }
    res.status(500).json({ code: 'internal_error', message });
  });

  return app;
}

export function startServer(port = Number(process.env.PORT || 4010)): void {
  const app = createApp();
  const server = app.listen(port, () => {
    startBackgroundJobs();
    // eslint-disable-next-line no-console
    console.log(`innies api listening on :${port}`);
  });

  const keepAliveTimeoutMs = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS || 75_000);
  const headersTimeoutMs = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || (keepAliveTimeoutMs + 1_000));
  const requestTimeoutMs = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 0);

  // Keep streaming connections stable and deterministic across Node versions.
  server.keepAliveTimeout = Math.max(1_000, keepAliveTimeoutMs);
  server.headersTimeout = Math.max(server.keepAliveTimeout + 1_000, headersTimeoutMs);
  server.requestTimeout = Math.max(0, requestTimeoutMs);
}

export function shouldAutoStartServer(input: {
  moduleUrl: string;
  entryArgv?: string;
  disableAutostart?: string;
}): boolean {
  if (input.disableAutostart === '1') return false;
  if (!input.entryArgv) return false;
  return pathToFileURL(input.entryArgv).href === input.moduleUrl;
}

if (shouldAutoStartServer({
  moduleUrl: import.meta.url,
  entryArgv: process.argv[1],
  disableAutostart: process.env.INNIES_NO_AUTOSTART
})) {
  startServer();
}
