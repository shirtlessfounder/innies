import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

function hasRequestBody(method) {
  const normalized = (method ?? 'GET').toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

export function buildClaudeProxyHeaders(input) {
  const headers = {};

  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (value == null) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      lowerName === 'authorization'
      || lowerName === 'host'
      || lowerName === 'content-length'
    ) {
      continue;
    }

    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers['x-api-key'] = input.buyerToken;
  headers['x-request-id'] = input.requestId;
  headers['x-innies-provider-pin'] = 'true';

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

function requestPathname(url) {
  return new URL(url || '/', 'http://127.0.0.1').pathname;
}

function hasJsonBody(headers) {
  const raw = headers?.['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.toLowerCase().includes('application/json');
}

function shouldRewriteCompatModel(req, sessionModel) {
  if (!sessionModel) return false;
  if (!hasRequestBody(req.method)) return false;
  if (!hasJsonBody(req.headers)) return false;
  return requestPathname(req.url) === '/v1/messages';
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function rewriteCompatModelBody(body, sessionModel) {
  if (!sessionModel) return body;

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return body;
    }
    if (typeof parsed.model !== 'string' || parsed.model.trim().length === 0) {
      return body;
    }
    if (parsed.model === sessionModel) {
      return body;
    }
    return JSON.stringify({
      ...parsed,
      model: sessionModel
    });
  } catch {
    return body;
  }
}

export async function startClaudeProxy(input) {
  const server = http.createServer(async (req, res) => {
    try {
      const targetUrl = new URL(req.url || '/', input.upstreamBaseUrl);
      const requestId = forwardedRequestId(req.headers, input.correlationId);
      const init = {
        method: req.method,
        headers: buildClaudeProxyHeaders({
          headers: req.headers,
          buyerToken: input.buyerToken,
          requestId
        })
      };

      if (hasRequestBody(req.method)) {
        if (shouldRewriteCompatModel(req, input.sessionModel)) {
          const originalBody = await readRequestBody(req);
          init.body = rewriteCompatModelBody(originalBody, input.sessionModel);
        } else {
          init.body = Readable.toWeb(req);
          init.duplex = 'half';
        }
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
        code: 'claude_proxy_error',
        message: `Innies Claude bridge failed: ${message}`
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
    throw new Error('Innies Claude bridge failed to bind a local port.');
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
