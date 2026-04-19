import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { buildCodexProxyHeaders, startCodexProxy } from '../src/commands/codexProxy.js';

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('codex proxy forwards x-openclaw-session-id on every request', async () => {
  const captured = [];
  const upstream = http.createServer((req, res) => {
    captured.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const { port } = upstream.address();
  const upstreamBaseUrl = `http://127.0.0.1:${port}`;
  const bridge = await startCodexProxy({
    upstreamBaseUrl,
    correlationId: 'corr_abc',
    sessionId: 'sess_codex_xyz'
  });

  // Two turns through the bridge — both should carry the same session id
  await fetch(`${bridge.baseUrl}/v1/proxy/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn: 1 })
  });
  await fetch(`${bridge.baseUrl}/v1/proxy/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn: 2 })
  });

  assert.equal(captured.length, 2);
  for (const row of captured) {
    assert.equal(row.url, '/v1/proxy/v1/responses');
    assert.equal(row.headers['x-openclaw-session-id'], 'sess_codex_xyz');
    assert.equal(row.headers['x-innies-provider-pin'], 'true');
    assert.match(String(row.headers['x-request-id']), /^corr_abc:/);
  }

  await bridge.close();
  await closeServer(upstream);
});

test('codex proxy preserves client-supplied x-request-id when present', async () => {
  let captured = null;
  const upstream = http.createServer((req, res) => {
    captured = { headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const { port } = upstream.address();
  const bridge = await startCodexProxy({
    upstreamBaseUrl: `http://127.0.0.1:${port}`,
    correlationId: 'corr_test',
    sessionId: 'sess_test'
  });

  await fetch(`${bridge.baseUrl}/v1/proxy/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'client-preferred-id'
    },
    body: '{}'
  });

  assert.equal(captured.headers['x-request-id'], 'client-preferred-id');

  await bridge.close();
  await closeServer(upstream);
});

test('buildCodexProxyHeaders omits x-openclaw-session-id when no sessionId is provided', () => {
  const headers = buildCodexProxyHeaders({
    headers: {},
    requestId: 'req_none'
  });

  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'x-openclaw-session-id'), false);
  assert.equal(headers['x-request-id'], 'req_none');
  assert.equal(headers['x-innies-provider-pin'], 'true');
});

test('buildCodexProxyHeaders strips host and content-length headers', () => {
  const headers = buildCodexProxyHeaders({
    headers: {
      host: 'irrelevant.example',
      'content-length': '1234',
      'user-agent': 'codex/0.121.0'
    },
    requestId: 'req_strip',
    sessionId: 'sess_strip'
  });

  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'content-length'), false);
  assert.equal(headers['user-agent'], 'codex/0.121.0');
});

test('codex proxy forwards request body and streams response', async () => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: JSON.parse(body) }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const { port } = upstream.address();
  const bridge = await startCodexProxy({
    upstreamBaseUrl: `http://127.0.0.1:${port}`,
    correlationId: 'corr_echo',
    sessionId: 'sess_echo'
  });

  const res = await fetch(`${bridge.baseUrl}/v1/proxy/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'bridge' })
  });

  assert.equal(res.status, 200);
  const parsed = await res.json();
  assert.deepEqual(parsed, { echoed: { hello: 'bridge' } });

  await bridge.close();
  await closeServer(upstream);
});
