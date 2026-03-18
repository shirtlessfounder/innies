import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { shouldAutoStartServer } from '../src/server.js';

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
