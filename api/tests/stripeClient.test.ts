import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripeClient } from '../src/services/payments/stripeClient.js';

describe('StripeClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates setup checkout sessions with an explicit card-only payment method type', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.test/session'
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new StripeClient({
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_test_123'
    });

    await expect(client.createSetupSession({
      customerId: 'cus_123',
      successUrl: 'http://localhost:3000/pilot',
      cancelUrl: 'http://localhost:3000/pilot',
      metadata: {
        wallet_id: 'org_fnf'
      }
    })).resolves.toEqual({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.test/session'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = new URLSearchParams(String(request.body ?? ''));

    expect(form.get('mode')).toBe('setup');
    expect(form.get('customer')).toBe('cus_123');
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.has('currency')).toBe(false);
    expect(form.get('setup_intent_data[metadata][wallet_id]')).toBe('org_fnf');
  });
});
