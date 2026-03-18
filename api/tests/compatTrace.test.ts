import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureCompatRawBody,
  persistCompatTraceBody,
  sanitizeTraceHeaders
} from '../src/utils/compatTrace.js';

describe('compat trace helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.INNIES_COMPAT_CAPTURE_DIR;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures raw /v1/messages request text only when capture is enabled', () => {
    const req = {} as { inniesRawBodyText?: string };

    captureCompatRawBody({
      req,
      method: 'POST',
      path: '/v1/messages',
      body: Buffer.from('{"model":"claude-opus-4-6"}', 'utf8'),
      captureDir: '/tmp/compat-capture'
    });

    expect(req.inniesRawBodyText).toBe('{"model":"claude-opus-4-6"}');

    const skippedReq = {} as { inniesRawBodyText?: string };
    captureCompatRawBody({
      req: skippedReq,
      method: 'POST',
      path: '/healthz',
      body: Buffer.from('{"ok":true}', 'utf8'),
      captureDir: '/tmp/compat-capture'
    });
    expect(skippedReq.inniesRawBodyText).toBeUndefined();
  });

  it('writes exact body and metadata files under the request id directory', () => {
    const captureDir = mkdtempSync(join(tmpdir(), 'innies-compat-trace-'));
    tempDirs.push(captureDir);
    process.env.INNIES_COMPAT_CAPTURE_DIR = captureDir;

    const result = persistCompatTraceBody({
      requestId: 'req/alpha:1',
      phase: 'ingress',
      body: '{\n  "tools": [{"name":"read"}]\n}',
      metadata: {
        path: '/v1/messages',
        method: 'POST'
      }
    });

    expect(result).toBeTruthy();
    expect(readFileSync(result!.bodyPath, 'utf8')).toBe('{\n  "tools": [{"name":"read"}]\n}');

    const metadata = JSON.parse(readFileSync(result!.metaPath, 'utf8'));
    expect(metadata.request_id).toBe('req/alpha:1');
    expect(metadata.phase).toBe('ingress');
    expect(metadata.body_bytes).toBe(Buffer.byteLength('{\n  "tools": [{"name":"read"}]\n}', 'utf8'));
    expect(metadata.body_path).toBe(result!.bodyPath);
    expect(result!.bodyPath).toContain('/req_alpha_1/');
    expect(result!.metaPath).toContain('/req_alpha_1/');
  });

  it('redacts auth secrets while preserving diagnostic headers', () => {
    expect(sanitizeTraceHeaders({
      Authorization: 'Bearer secret-token-value',
      'x-api-key': 'sk-live-abc',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'x-request-id': 'req_trace_1'
    })).toEqual({
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      authorization: expect.stringMatching(/^Bearer <redacted:/),
      'x-api-key': expect.stringMatching(/^<redacted:/),
      'x-request-id': 'req_trace_1'
    });
  });
});
