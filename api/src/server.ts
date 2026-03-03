import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import adminRoutes from './routes/admin.js';
import anthropicCompatRoutes from './routes/anthropicCompat.js';
import proxyRoutes from './routes/proxy.js';
import sellerKeysRoutes from './routes/sellerKeys.js';
import usageRoutes from './routes/usage.js';
import { startBackgroundJobs } from './services/runtime.js';
import { AppError } from './utils/errors.js';

export function createApp(): express.Express {
  const app = express();
  const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '20mb';
  app.use(express.json({ limit: jsonBodyLimit }));

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
  app.use(anthropicCompatRoutes);
  app.use(sellerKeysRoutes);
  app.use(usageRoutes);
  app.use(proxyRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ code: 'invalid_request', message: 'Invalid request', issues: err.issues });
      return;
    }

    if (err instanceof AppError) {
      res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
      return;
    }

    const message = err instanceof Error ? err.message : 'Unexpected error';
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

startServer();
