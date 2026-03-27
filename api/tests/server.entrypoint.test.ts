import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

type ServerModule = typeof import('../src/server.js');

const requiredEnvDefaults = {
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/innies_test',
  SELLER_SECRET_ENC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  INNIES_NO_AUTOSTART: '1'
} satisfies Record<string, string>;

const originalEnv = Object.fromEntries(
  Object.keys(requiredEnvDefaults).map((name) => [name, process.env[name]])
) as Record<keyof typeof requiredEnvDefaults, string | undefined>;

let shouldAutoStartServer: ServerModule['shouldAutoStartServer'];

beforeAll(async () => {
  for (const [name, value] of Object.entries(requiredEnvDefaults)) {
    process.env[name] = process.env[name] || value;
  }

  ({ shouldAutoStartServer } = await import('../src/server.js'));
});

afterAll(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = value;
  }
});

describe('server entrypoint guard', () => {
  it('auto-starts only when executed as the entrypoint', () => {
    const entryArgv = '/tmp/innies-server.ts';

    expect(shouldAutoStartServer({
      moduleUrl: pathToFileURL(entryArgv).href,
      entryArgv
    })).toBe(true);
  });

  it('does not auto-start when explicitly disabled', () => {
    expect(shouldAutoStartServer({
      moduleUrl: pathToFileURL('/tmp/innies-server.ts').href,
      entryArgv: '/tmp/innies-server.ts',
      disableAutostart: '1'
    })).toBe(false);
  });

  it('does not auto-start when imported from another entrypoint', () => {
    expect(shouldAutoStartServer({
      moduleUrl: pathToFileURL('/tmp/innies-server.ts').href,
      entryArgv: '/tmp/other-entry.ts'
    })).toBe(false);
  });
});
