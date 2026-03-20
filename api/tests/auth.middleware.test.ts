import { describe, expect, it, vi } from 'vitest';
import { requireApiKey } from '../src/middleware/auth.js';
import { sha256Hex } from '../src/utils/hash.js';

function createMockReq(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    auth: undefined,
    header(name: string) {
      return lower[name.toLowerCase()];
    }
  } as any;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
    }
  } as any;
}

describe('requireApiKey', () => {
  it('fails closed for frozen buyer keys', async () => {
    const repo = {
      findActiveByHash: vi.fn().mockResolvedValue({
        id: 'buyer_1',
        org_id: 'org_fnf',
        scope: 'buyer_proxy',
        is_active: true,
        expires_at: null,
        preferred_provider: null,
        is_frozen: true
      }),
      touchLastUsed: vi.fn().mockResolvedValue(undefined)
    } as any;

    const middleware = requireApiKey(repo, ['buyer_proxy']);
    const req = createMockReq({ 'x-api-key': 'buyer-token' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(repo.findActiveByHash).toHaveBeenCalledWith(sha256Hex('buyer-token'));
    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({
      code: 'cutover_in_progress',
      message: 'Buyer key is temporarily unavailable during cutover'
    });
    expect(repo.touchLastUsed).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('populates request auth for active unfrozen buyer keys', async () => {
    const repo = {
      findActiveByHash: vi.fn().mockResolvedValue({
        id: 'buyer_1',
        org_id: 'org_fnf',
        scope: 'buyer_proxy',
        name: 'darryn',
        is_active: true,
        expires_at: null,
        preferred_provider: null,
        is_frozen: false
      }),
      touchLastUsed: vi.fn().mockResolvedValue(undefined)
    } as any;

    const middleware = requireApiKey(repo, ['buyer_proxy']);
    const req = createMockReq({ authorization: 'Bearer buyer-token' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(req.auth).toEqual(expect.objectContaining({
      apiKeyId: 'buyer_1',
      orgId: 'org_fnf',
      scope: 'buyer_proxy',
      buyerKeyLabel: 'darryn'
    }));
    expect(repo.touchLastUsed).toHaveBeenCalledWith('buyer_1');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
