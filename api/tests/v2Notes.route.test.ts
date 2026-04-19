process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');

import { beforeAll, describe, expect, it } from 'vitest';

type RouteModule = typeof import('../src/routes/v2Notes.js');
let buildV2NotesRouter: RouteModule['buildV2NotesRouter'];

beforeAll(async () => {
  const mod = await import('../src/routes/v2Notes.js');
  buildV2NotesRouter = mod.buildV2NotesRouter;
});

type AnyHandler = (req: any, res: any, next: (error?: unknown) => void) => unknown;

function extractHandlers(router: any, path: string, method: 'get' | 'put' | 'options'): AnyHandler[] {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s: any) => s.handle);
}

function createMockRes() {
  const headers: Record<string, string> = {};
  const state: { statusCode: number; body: unknown; ended: boolean } = {
    statusCode: 200,
    body: undefined,
    ended: false
  };
  const res: any = {
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    get headers() { return headers; },
    get writableEnded() { return state.ended; },
    setHeader(name: string, value: string) { headers[name] = value; },
    getHeader(name: string) { return headers[name]; },
    status(code: number) { state.statusCode = code; return res; },
    json(payload: unknown) { state.body = payload; state.ended = true; },
    end() { state.ended = true; },
    flushHeaders() {}
  };
  return res;
}

function fakeRepo(overrides: { document?: any; save?: any } = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  return {
    calls,
    async getDocument() {
      calls.push({ method: 'getDocument', args: [] });
      return overrides.document ?? { id: 'v2:notes.md', content: '', revision: 0, updatedAt: '2026-04-19T00:00:00Z' };
    },
    async saveDocument(content: string, baseRevision: number | null) {
      calls.push({ method: 'saveDocument', args: [content, baseRevision] });
      return overrides.save ?? { id: 'v2:notes.md', content, revision: (baseRevision ?? 0) + 1, updatedAt: '2026-04-19T00:00:01Z' };
    },
    async listen() {
      return async () => {};
    }
  };
}

describe('v2Notes router', () => {
  it('GET /v2/notes returns the current document with no-store cache', async () => {
    const repo = fakeRepo();
    const router = buildV2NotesRouter({ repository: repo as any });
    const [handler] = extractHandlers(router, '/v2/notes', 'get');

    const req: any = { header: () => undefined, body: undefined };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'v2:notes.md' }));
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(repo.calls).toEqual([{ method: 'getDocument', args: [] }]);
  });

  it('PUT /v2/notes rejects non-string content with 400', async () => {
    const repo = fakeRepo();
    const router = buildV2NotesRouter({ repository: repo as any });
    const [handler] = extractHandlers(router, '/v2/notes', 'put');

    const req: any = { header: () => undefined, body: { content: 123 } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: '`content` must be a string' });
  });

  it('PUT /v2/notes rejects oversize content with 400', async () => {
    const repo = fakeRepo();
    const router = buildV2NotesRouter({ repository: repo as any });
    const [handler] = extractHandlers(router, '/v2/notes', 'put');

    const req: any = { header: () => undefined, body: { content: 'x'.repeat(50_001) } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(String((res.body as any).error)).toContain('too large');
  });

  it('PUT /v2/notes saves and returns the new revision', async () => {
    const repo = fakeRepo();
    const router = buildV2NotesRouter({ repository: repo as any });
    const [handler] = extractHandlers(router, '/v2/notes', 'put');

    const req: any = { header: () => undefined, body: { content: 'hello', baseRevision: 3 } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ content: 'hello', revision: 4 }));
    expect(repo.calls).toEqual([{ method: 'saveDocument', args: ['hello', 3] }]);
  });

  it('OPTIONS preflight echoes allowed origin + methods', async () => {
    const router = buildV2NotesRouter({ env: { V2_NOTES_ALLOWED_ORIGINS: 'https://innies.work,https://www.innies.work' } as any });
    const [handler] = extractHandlers(router, '/v2/notes', 'options');

    const req: any = { header: (name: string) => (name.toLowerCase() === 'origin' ? 'https://innies.work' : undefined) };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://innies.work');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('PUT');
  });

  it('OPTIONS preflight does not set Allow-Origin for untrusted origin', async () => {
    const router = buildV2NotesRouter({ env: { V2_NOTES_ALLOWED_ORIGINS: 'https://innies.work' } as any });
    const [handler] = extractHandlers(router, '/v2/notes', 'options');

    const req: any = { header: (name: string) => (name.toLowerCase() === 'origin' ? 'https://evil.example' : undefined) };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
