import { afterEach, describe, expect, it } from 'vitest';
import {
  readPilotApiBaseUrl,
  readPilotGithubCallbackUrl,
  readPilotUiBaseUrl
} from '../src/services/pilot/pilotUrlConfig.js';

const originalEnv = {
  INNIES_BASE_URL: process.env.INNIES_BASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  PILOT_GITHUB_CALLBACK_URL: process.env.PILOT_GITHUB_CALLBACK_URL,
  PILOT_UI_BASE_URL: process.env.PILOT_UI_BASE_URL,
  UI_BASE_URL: process.env.UI_BASE_URL
};

afterEach(() => {
  restoreEnv('INNIES_BASE_URL', originalEnv.INNIES_BASE_URL);
  restoreEnv('NODE_ENV', originalEnv.NODE_ENV);
  restoreEnv('PILOT_GITHUB_CALLBACK_URL', originalEnv.PILOT_GITHUB_CALLBACK_URL);
  restoreEnv('PILOT_UI_BASE_URL', originalEnv.PILOT_UI_BASE_URL);
  restoreEnv('UI_BASE_URL', originalEnv.UI_BASE_URL);
});

describe('pilotUrlConfig', () => {
  it('falls back to the canonical prod UI host when no UI env is set', () => {
    delete process.env.PILOT_UI_BASE_URL;
    delete process.env.UI_BASE_URL;

    expect(readPilotUiBaseUrl()).toBe('https://www.innies.computer');
  });

  it('derives the pilot GitHub callback URL from INNIES_BASE_URL when not explicitly set', () => {
    delete process.env.PILOT_GITHUB_CALLBACK_URL;
    process.env.INNIES_BASE_URL = 'https://api.innies.computer/';

    expect(readPilotApiBaseUrl()).toBe('https://api.innies.computer');
    expect(readPilotGithubCallbackUrl()).toBe('https://api.innies.computer/v1/pilot/auth/github/callback');
  });

  it('fails closed in production when no pilot callback base URL is configured', () => {
    delete process.env.INNIES_BASE_URL;
    delete process.env.PILOT_GITHUB_CALLBACK_URL;
    process.env.NODE_ENV = 'production';

    expect(() => readPilotGithubCallbackUrl()).toThrow(
      'Missing pilot GitHub callback configuration. Set PILOT_GITHUB_CALLBACK_URL or INNIES_BASE_URL.'
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
