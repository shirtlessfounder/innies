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
    if (lowerName === 'authorization' || lowerName === 'host') {
      continue;
    }

    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers['x-api-key'] = input.buyerToken;
  headers['x-request-id'] = input.correlationId;
  headers['x-innies-provider-pin'] = 'true';

  return headers;
}

export async function startClaudeProxy(input) {
  const server = http.createServer(async (req, res) => {
    try {
      const targetUrl = new URL(req.url || '/', input.upstreamBaseUrl);
      const init = {
        method: req.method,
        headers: buildClaudeProxyHeaders({
          headers: req.headers,
          buyerToken: input.buyerToken,
          correlationId: input.correlationId
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
