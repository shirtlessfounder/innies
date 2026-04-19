import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

function hasRequestBody(method) {
  const normalized = (method ?? 'GET').toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

/**
 * Build outgoing headers from an incoming codex request.
 *
 * Copies everything codex sent, then stamps in the CLI-invocation
 * correlation id and session id so every turn of a single `innies codex`
 * run groups under one session on the Innies side. Strips `host` and
 * `content-length` (they are managed by the fetch layer on forward).
 */
export function buildCodexProxyHeaders(input) {
  const headers = {};

  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (value == null) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (lowerName === 'host' || lowerName === 'content-length') {
      continue;
    }

    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers['x-request-id'] = input.requestId;
  headers['x-innies-provider-pin'] = 'true';

  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    headers['x-openclaw-session-id'] = input.sessionId;
  }

  return headers;
}

function forwardedRequestId(headers, correlationId) {
  const raw = headers?.['x-request-id'];
  if (Array.isArray(raw)) {
    const value = raw.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (value) return value.trim();
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return `${correlationId}:${randomUUID()}`;
}

/**
 * Start a local HTTP bridge that codex talks to. Every request codex
 * issues is proxied to `input.upstreamBaseUrl` (the real Innies API) with
 * `x-openclaw-session-id` stamped in, regardless of whether codex honors
 * its own `env_http_headers` config. This matches the approach used by
 * `startClaudeProxy` for the anthropic lane.
 */
export async function startCodexProxy(input) {
  const server = http.createServer(async (req, res) => {
    try {
      const targetUrl = new URL(req.url || '/', input.upstreamBaseUrl);
      const requestId = forwardedRequestId(req.headers, input.correlationId);
      const init = {
        method: req.method,
        headers: buildCodexProxyHeaders({
          headers: req.headers,
          requestId,
          sessionId: input.sessionId
        })
      };

      if (hasRequestBody(req.method)) {
        init.body = Readable.toWeb(req);
        init.duplex = 'half';
      }

      const upstreamResponse = await fetch(targetUrl, init);
      const responseHeaders = {};
      upstreamResponse.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });

      res.writeHead(upstreamResponse.status, responseHeaders);

      if (!upstreamResponse.body) {
        res.end();
        return;
      }

      Readable.fromWeb(upstreamResponse.body).pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 'codex_proxy_error',
        message: `Innies Codex bridge failed: ${message}`
      }));
    }
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Innies Codex bridge failed to bind a local port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}
