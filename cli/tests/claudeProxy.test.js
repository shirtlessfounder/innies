import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { buildClaudeProxyHeaders, startClaudeProxy } from '../src/commands/claudeProxy.js';

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

test('claude proxy injects buyer auth and strips claude oauth auth', async () => {
  let capturedRequest = null;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      capturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-upstream-ok': '1'
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const upstreamAddress = upstream.address();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const proxy = await startClaudeProxy({
    upstreamBaseUrl,
    buyerToken: 'in_live_test',
    correlationId: 'req_test_123',
    sessionModel: 'claude-opus-4-6'
  });

  const response = await fetch(`${proxy.baseUrl}/v1/messages?hello=1`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-ant-oat01-test-token',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-request-id': 'client-supplied'
    },
    body: JSON.stringify({ ping: 'pong' })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.method, 'POST');
  assert.equal(capturedRequest.url, '/v1/messages?hello=1');
  assert.equal(capturedRequest.body, '{"ping":"pong"}');
  assert.equal(capturedRequest.headers.authorization, undefined);
  assert.equal(capturedRequest.headers['x-api-key'], 'in_live_test');
  assert.equal(capturedRequest.headers['x-request-id'], 'client-supplied');
  assert.equal(capturedRequest.headers['x-innies-provider-pin'], 'true');
  assert.equal(capturedRequest.headers['anthropic-version'], '2023-06-01');

  await proxy.close();
  await closeServer(upstream);
});

test('claude proxy forwards x-openclaw-session-id when a sessionId is provided', async () => {
  let capturedRequest = null;
  const upstream = http.createServer((req, res) => {
    capturedRequest = { headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const upstreamAddress = upstream.address();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const proxy = await startClaudeProxy({
    upstreamBaseUrl,
    buyerToken: 'in_live_test',
    correlationId: 'req_sid_xyz',
    sessionId: 'sess_abc_uuid',
    sessionModel: 'claude-opus-4-6'
  });

  const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' }
  });

  assert.equal(response.status, 200);
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.headers['x-openclaw-session-id'], 'sess_abc_uuid');

  await proxy.close();
  await closeServer(upstream);
});

test('buildClaudeProxyHeaders omits x-openclaw-session-id when no sessionId is provided', () => {
  const headers = buildClaudeProxyHeaders({
    headers: {},
    buyerToken: 'in_live_test',
    requestId: 'req_no_session'
  });

  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'x-openclaw-session-id'), false);
});

test('claude proxy rewrites compat request model to the wrapped session model', async () => {
  let capturedRequest = null;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      capturedRequest = {
        url: req.url,
        headers: req.headers,
        body
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const upstreamAddress = upstream.address();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const proxy = await startClaudeProxy({
    upstreamBaseUrl,
    buyerToken: 'in_live_test',
    correlationId: 'req_session_123',
    sessionModel: 'claude-opus-4-6'
  });

  const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-subagent-fast',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }]
    })
  });

  assert.equal(response.status, 200);
  assert.ok(capturedRequest);
  assert.match(String(capturedRequest.headers['x-request-id']), /^req_session_123:/);
  assert.deepEqual(JSON.parse(capturedRequest.body), {
    model: 'claude-opus-4-6',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }]
  });

  await proxy.close();
  await closeServer(upstream);
});
