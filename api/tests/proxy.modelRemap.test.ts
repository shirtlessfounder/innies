import { afterEach, describe, expect, it, vi } from 'vitest';

type ProxyRouteModule = typeof import('../src/routes/proxy.js');

const REQUESTED_OPUS_MODEL = 'claude-opus-4-6';
const REQUESTED_OPUS_SNAPSHOT_MODEL = 'claude-opus-4-20250514';
const REMAPPED_SONNET_MODEL = 'claude-sonnet-4-6';

async function loadProxyRouteModule(): Promise<ProxyRouteModule> {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
  process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
  vi.resetModules();
  return await import('../src/routes/proxy.js') as ProxyRouteModule;
}

afterEach(() => {
  delete process.env.ANTHROPIC_FORCE_OPUS_MODEL;
});

describe('proxy model remap', () => {
  it('remaps wrapped anthropic opus requests to sonnet when enabled', async () => {
    process.env.ANTHROPIC_FORCE_OPUS_MODEL = REMAPPED_SONNET_MODEL;
    const { parseProxyRequestBody } = await loadProxyRouteModule();

    const parsed = parseProxyRequestBody({
      provider: 'anthropic',
      model: REQUESTED_OPUS_MODEL,
      streaming: false,
      payload: {
        model: REQUESTED_OPUS_MODEL,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }]
      }
    }, '/v1/messages');

    expect(parsed).toMatchObject({
      provider: 'anthropic',
      model: REMAPPED_SONNET_MODEL,
      streaming: false,
      payload: {
        model: REMAPPED_SONNET_MODEL,
        max_tokens: 8
      }
    });
  });

  it('remaps native anthropic opus snapshot requests to sonnet when enabled', async () => {
    process.env.ANTHROPIC_FORCE_OPUS_MODEL = REMAPPED_SONNET_MODEL;
    const { parseProxyRequestBody } = await loadProxyRouteModule();

    const parsed = parseProxyRequestBody({
      model: REQUESTED_OPUS_SNAPSHOT_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    }, '/v1/messages');

    expect(parsed).toMatchObject({
      provider: 'anthropic',
      model: REMAPPED_SONNET_MODEL,
      streaming: true,
      payload: {
        model: REMAPPED_SONNET_MODEL,
        max_tokens: 8,
        stream: true
      }
    });
  });

  it('leaves opus requests unchanged when no remap target is configured', async () => {
    const { parseProxyRequestBody } = await loadProxyRouteModule();

    const parsed = parseProxyRequestBody({
      provider: 'anthropic',
      model: REQUESTED_OPUS_MODEL,
      streaming: false,
      payload: {
        model: REQUESTED_OPUS_MODEL,
        max_tokens: 8
      }
    }, '/v1/messages');

    expect(parsed).toMatchObject({
      provider: 'anthropic',
      model: REQUESTED_OPUS_MODEL,
      payload: {
        model: REQUESTED_OPUS_MODEL,
        max_tokens: 8
      }
    });
  });
});
