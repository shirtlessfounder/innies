import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type PaymentsRouteModule = typeof import('../src/routes/payments.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  body: unknown;
  header: (name: string) => string | undefined;
  inniesRawBodyText?: string;
};

type MockRes = {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  status: (code: number) => MockRes;
  json: (payload: unknown) => void;
  send: (payload: unknown) => void;
};

function createMockReq(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  rawBody?: string;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    method: input.method.toUpperCase(),
    path: input.path,
    originalUrl: input.path,
    body: {},
    inniesRawBodyText: input.rawBody,
    header: (name: string) => lower[name.toLowerCase()]
  };
}

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      this.writableEnded = true;
    },
    send(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      this.writableEnded = true;
    }
  };
}

function applyError(err: unknown, res: MockRes): void {
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
}

async function invoke(handle: (req: any, res: any, next: (error?: unknown) => void) => unknown, req: MockReq, res: MockRes): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let nextCalled = false;
    const next = (error?: unknown) => {
      nextCalled = true;
      if (error) {
        applyError(error, res);
      }
      resolve();
    };

    Promise.resolve(handle(req, res, next))
      .then(() => {
        if (!nextCalled) resolve();
      })
      .catch(reject);
  });
}

function getRouteHandlers(router: any, routePath: string, method: 'post'): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
}

describe('payments routes', () => {
  let runtimeModule: RuntimeModule;
  let webhookHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/payments.js') as PaymentsRouteModule;
    webhookHandlers = getRouteHandlers(mod.default as any, '/v1/payments/webhooks/stripe', 'post');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.services.payments, 'processWebhook').mockResolvedValue({
      accepted: true,
      processorEventId: 'evt_1',
      outcomes: [{
        walletId: 'org_fnf',
        processorEffectId: 'stripe:payment_intent:pi_1',
        effectType: 'payment_credit'
      }]
    } as any);
    vi.spyOn(runtimeModule.runtime.services.payments, 'markWebhookProcessed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'recordPaymentOutcome').mockResolvedValue({
      id: 'wallet_entry_1'
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes Stripe webhooks and records wallet outcomes through the wallet-owned seam', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/payments/webhooks/stripe',
      headers: {
        'stripe-signature': 't=1,v1=abc'
      },
      rawBody: '{"id":"evt_1"}'
    });
    const res = createMockRes();

    await invoke(webhookHandlers[0], req, res);

    expect(runtimeModule.runtime.services.payments.processWebhook).toHaveBeenCalledWith({
      signatureHeader: 't=1,v1=abc',
      rawBody: '{"id":"evt_1"}'
    });
    expect(runtimeModule.runtime.services.wallets.recordPaymentOutcome).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      processorEffectId: 'stripe:payment_intent:pi_1',
      effectType: 'payment_credit'
    });
    expect(runtimeModule.runtime.services.payments.markWebhookProcessed).toHaveBeenCalledWith('evt_1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      accepted: true,
      recordedOutcomes: 1
    });
  });

  it('does not mark the webhook processed when wallet recording fails', async () => {
    vi.mocked(runtimeModule.runtime.services.wallets.recordPaymentOutcome).mockRejectedValueOnce(
      new AppError('wallet_write_failed', 500, 'wallet write failed')
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/payments/webhooks/stripe',
      headers: {
        'stripe-signature': 't=1,v1=abc'
      },
      rawBody: '{"id":"evt_1"}'
    });
    const res = createMockRes();

    await invoke(webhookHandlers[0], req, res);

    expect(runtimeModule.runtime.services.payments.markWebhookProcessed).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });
});
