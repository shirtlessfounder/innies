import { describe, expect, it, vi } from 'vitest';
import { requireApiKey } from '../src/middleware/auth.js';

function createReq(headers: Record<string, string> = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    auth: undefined as any,
    header(name: string) {
      return normalized[name.toLowerCase()];
    }
  } as any;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  } as any;
}

describe('requireApiKey', () => {
  it('fails closed when a buyer key is frozen for cutover', async () => {
    const repo = {
      findActiveByHash: vi.fn().mockResolvedValue({
        id: 'buyer_1',
        org_id: 'org_innies',
        scope: 'buyer_proxy',
        is_active: true,
        expires_at: null,
        preferred_provider: null,
        active_freeze_operation_kind: 'cutover'
      }),
      touchLastUsed: vi.fn()
    } as any;

    const middleware = requireApiKey(repo, ['buyer_proxy']);
    const req = createReq({ 'x-api-key': 'live_key' });
    const res = createRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({
      code: 'pilot_migration_locked',
      message: 'Buyer key is temporarily unavailable during pilot cutover migration'
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches auth when the buyer key is active', async () => {
    const repo = {
      findActiveByHash: vi.fn().mockResolvedValue({
        id: 'buyer_1',
        org_id: 'org_fnf',
        scope: 'buyer_proxy',
        name: 'darryn',
        is_active: true,
        expires_at: null,
        preferred_provider: 'openai',
        active_freeze_operation_kind: null
      }),
      touchLastUsed: vi.fn().mockResolvedValue(undefined)
    } as any;

    const middleware = requireApiKey(repo, ['buyer_proxy']);
    const req = createReq({ authorization: 'Bearer live_key' });
    const res = createRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(req.auth).toEqual(expect.objectContaining({
      apiKeyId: 'buyer_1',
      orgId: 'org_fnf',
      scope: 'buyer_proxy',
      preferredProvider: 'openai'
    }));
    expect(repo.touchLastUsed).toHaveBeenCalledWith('buyer_1');
    expect(next).toHaveBeenCalledWith();
  });
});
