import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, message: string, code?: string | null, details?: Record<string, unknown> | null) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
    this.code = code ?? null;
    this.details = details ?? null;
  }
}

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: {
    object: Record<string, any>;
  };
};

export type StripeOffSessionChargeResult =
  | { kind: 'succeeded'; paymentIntentId: string }
  | { kind: 'pending'; paymentIntentId: string }
  | { kind: 'failed'; paymentIntentId: string | null; errorCode: string | null; errorMessage: string };

export class StripeClient {
  constructor(private readonly config: {
    secretKey: string;
    webhookSecret: string;
    apiBaseUrl?: string;
  }) {}

  async createCustomer(input: {
    email?: string | null;
    metadata?: Record<string, string>;
  }): Promise<{ customerId: string }> {
    const response = await this.request('/customers', {
      method: 'POST',
      form: {
        email: input.email ?? undefined,
        metadata: input.metadata ?? undefined
      }
    });

    return {
      customerId: readRequiredString(response, 'id')
    };
  }

  async createSetupSession(input: {
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    const response = await this.request('/checkout/sessions', {
      method: 'POST',
      form: {
        mode: 'setup',
        customer: input.customerId,
        payment_method_types: ['card'],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        setup_intent_data: {
          metadata: input.metadata ?? {}
        }
      }
    });

    return {
      id: readRequiredString(response, 'id'),
      url: readRequiredString(response, 'url')
    };
  }

  async createPaymentSession(input: {
    customerId: string;
    amountMinor: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey?: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    const response = await this.request('/checkout/sessions', {
      method: 'POST',
      headers: input.idempotencyKey
        ? {
          'Idempotency-Key': input.idempotencyKey
        }
        : undefined,
      form: {
        mode: 'payment',
        customer: input.customerId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': input.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(input.amountMinor),
        'line_items[0][price_data][product_data][name]': 'Innies wallet top-up',
        payment_intent_data: {
          metadata: input.metadata ?? {}
        }
      }
    });

    return {
      id: readRequiredString(response, 'id'),
      url: readRequiredString(response, 'url')
    };
  }

  async createOffSessionCharge(input: {
    customerId: string;
    paymentMethodId: string;
    amountMinor: number;
    currency: string;
    metadata?: Record<string, string>;
  }): Promise<StripeOffSessionChargeResult> {
    try {
      const response = await this.request('/payment_intents', {
        method: 'POST',
        form: {
          amount: String(input.amountMinor),
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          off_session: 'true',
          confirm: 'true',
          metadata: input.metadata ?? {}
        }
      });

      const paymentIntentId = readRequiredString(response, 'id');
      const status = readRequiredString(response, 'status');
      if (status === 'succeeded') {
        return {
          kind: 'succeeded',
          paymentIntentId
        };
      }

      if (status === 'processing' || status === 'requires_action' || status === 'requires_capture') {
        return {
          kind: 'pending',
          paymentIntentId
        };
      }

      const lastError = asRecord(response.last_payment_error);
      return {
        kind: 'failed',
        paymentIntentId,
        errorCode: readOptionalString(lastError?.code),
        errorMessage: readOptionalString(lastError?.message) ?? 'Stripe payment intent failed'
      };
    } catch (error) {
      if (error instanceof StripeApiError) {
        const errorBody = asRecord(error.details?.error);
        return {
          kind: 'failed',
          paymentIntentId: readOptionalString(errorBody?.payment_intent),
          errorCode: error.code,
          errorMessage: error.message
        };
      }
      throw error;
    }
  }

  async detachPaymentMethod(processorPaymentMethodId: string): Promise<void> {
    await this.request(`/payment_methods/${processorPaymentMethodId}/detach`, {
      method: 'POST',
      form: {}
    });
  }

  async retrievePaymentMethod(processorPaymentMethodId: string): Promise<Record<string, any>> {
    return this.request(`/payment_methods/${processorPaymentMethodId}`, {
      method: 'GET'
    });
  }

  constructWebhookEvent(input: {
    signatureHeader: string | undefined;
    rawBody: string;
  }): StripeWebhookEvent {
    if (!input.signatureHeader) {
      throw new StripeApiError(400, 'Missing Stripe signature header');
    }

    const webhookSecret = this.config.webhookSecret.trim();
    if (!webhookSecret) {
      throw new StripeApiError(500, 'Missing Stripe webhook secret');
    }

    const parsed = parseStripeSignature(input.signatureHeader);
    const payload = `${parsed.timestamp}.${input.rawBody}`;
    const expected = createHmac('sha256', webhookSecret).update(payload, 'utf8').digest('hex');
    const actualBuffer = Buffer.from(parsed.signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    if (
      actualBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new StripeApiError(400, 'Invalid Stripe signature');
    }

    const body = JSON.parse(input.rawBody) as StripeWebhookEvent;
    if (!body || typeof body.id !== 'string' || typeof body.type !== 'string') {
      throw new StripeApiError(400, 'Invalid Stripe webhook payload');
    }
    return body;
  }

  private async request(path: string, input: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    form?: Record<string, unknown>;
  }): Promise<Record<string, any>> {
    const secretKey = this.config.secretKey.trim();
    if (!secretKey) {
      throw new StripeApiError(500, 'Missing Stripe secret key');
    }

    const body = input.form ? toFormBody(input.form).toString() : undefined;
    const response = await fetch(`${this.config.apiBaseUrl ?? 'https://api.stripe.com/v1'}${path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(input.headers ?? {})
      },
      body
    });

    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) as Record<string, any> : {};
    if (!response.ok) {
      const errorBody = asRecord(parsed.error);
      throw new StripeApiError(
        response.status,
        readOptionalString(errorBody?.message) ?? `Stripe request failed (${response.status})`,
        readOptionalString(errorBody?.code),
        parsed
      );
    }

    return parsed;
  }
}

function toFormBody(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  appendFormEntries(params, '', input);
  return params;
}

function appendFormEntries(params: URLSearchParams, prefix: string, value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (value === null) {
    params.append(prefix, '');
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    params.append(prefix, String(value));
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendFormEntries(params, `${prefix}[${index}]`, item);
    });
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPrefix = prefix ? `${prefix}[${key}]` : key;
    appendFormEntries(params, nextPrefix, nested);
  }
}

function parseStripeSignature(header: string): {
  timestamp: string;
  signature: string;
} {
  const values = Object.fromEntries(
    header.split(',')
      .map((part) => part.trim().split('='))
      .filter((entry): entry is [string, string] => entry.length === 2)
  );

  const timestamp = values.t;
  const signature = values.v1;
  if (!timestamp || !signature) {
    throw new StripeApiError(400, 'Invalid Stripe signature header');
  }

  return {
    timestamp,
    signature
  };
}

function readRequiredString(input: Record<string, any>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StripeApiError(500, `Missing Stripe response field: ${key}`);
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, any> : null;
}
