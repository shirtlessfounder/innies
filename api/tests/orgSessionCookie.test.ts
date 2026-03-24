import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClearOrgRevealCookie,
  buildClearOrgSessionCookie,
  buildOrgRevealCookie,
  buildOrgSessionCookie,
  readOrgRevealCookie,
  readOrgSessionTokenFromRequest
} from '../src/services/org/orgSessionCookie.js';

const originalEnv = {
  INNIES_BASE_URL: process.env.INNIES_BASE_URL,
  ORG_REVEAL_SECRET: process.env.ORG_REVEAL_SECRET,
  PILOT_GITHUB_CALLBACK_URL: process.env.PILOT_GITHUB_CALLBACK_URL,
  PILOT_UI_BASE_URL: process.env.PILOT_UI_BASE_URL,
  UI_BASE_URL: process.env.UI_BASE_URL
};

afterEach(() => {
  restoreEnv('INNIES_BASE_URL', originalEnv.INNIES_BASE_URL);
  restoreEnv('ORG_REVEAL_SECRET', originalEnv.ORG_REVEAL_SECRET);
  restoreEnv('PILOT_GITHUB_CALLBACK_URL', originalEnv.PILOT_GITHUB_CALLBACK_URL);
  restoreEnv('PILOT_UI_BASE_URL', originalEnv.PILOT_UI_BASE_URL);
  restoreEnv('UI_BASE_URL', originalEnv.UI_BASE_URL);
});

describe('orgSessionCookie', () => {
  it('mirrors the pilot cookie-domain behavior for org session cookies', () => {
    process.env.PILOT_UI_BASE_URL = 'https://www.innies.computer';
    process.env.INNIES_BASE_URL = 'https://api.innies.computer';

    expect(buildOrgSessionCookie('signed-token')).toContain('innies_org_session=signed-token');
    expect(buildOrgSessionCookie('signed-token')).toContain('Path=/');
    expect(buildOrgSessionCookie('signed-token')).toContain('HttpOnly');
    expect(buildOrgSessionCookie('signed-token')).toContain('SameSite=Lax');
    expect(buildOrgSessionCookie('signed-token')).toContain('Domain=innies.computer');
    expect(buildOrgSessionCookie('signed-token')).toContain('Secure');

    expect(buildClearOrgSessionCookie()).toContain('innies_org_session=');
    expect(buildClearOrgSessionCookie()).toContain('Max-Age=0');
    expect(buildClearOrgSessionCookie()).toContain('Domain=innies.computer');
  });

  it('prefers bearer tokens over cookies for org session reads', () => {
    expect(readOrgSessionTokenFromRequest({
      header(name: string) {
        if (name.toLowerCase() === 'authorization') {
          return 'Bearer bearer-token';
        }
        if (name.toLowerCase() === 'cookie') {
          return 'other=1; innies_org_session=cookie-token';
        }
        return undefined;
      }
    })).toBe('bearer-token');
  });

  it('encrypts, authenticates, and reads org reveal cookies scoped to one org path', () => {
    process.env.ORG_REVEAL_SECRET = 'org-reveal-secret';
    process.env.PILOT_UI_BASE_URL = 'https://www.innies.computer';
    process.env.INNIES_BASE_URL = 'https://api.innies.computer';

    const cookie = buildOrgRevealCookie({
      orgSlug: 'launch-team',
      buyerKey: 'in_live_reveal_me_once',
      reason: 'org_created'
    });

    expect(cookie).toContain('innies_org_reveal=');
    expect(cookie).toContain('Path=/launch-team');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Domain=innies.computer');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('in_live_reveal_me_once');

    const cookieValue = cookie.split(';')[0];
    expect(readOrgRevealCookie({
      orgSlug: 'launch-team',
      cookieHeader: `${cookieValue}; other=1`
    })).toEqual({
      buyerKey: 'in_live_reveal_me_once',
      reason: 'org_created'
    });
    expect(readOrgRevealCookie({
      orgSlug: 'launch-team',
      cookieHeader: `${cookieValue}; other=1`
    })).toEqual({
      buyerKey: 'in_live_reveal_me_once',
      reason: 'org_created'
    });
    expect(readOrgRevealCookie({
      orgSlug: 'other-team',
      cookieHeader: cookieValue
    })).toBeNull();
    expect(readOrgRevealCookie({
      orgSlug: 'launch-team',
      cookieHeader: `${cookieValue}tampered`
    })).toBeNull();
  });

  it('builds a scoped clear cookie for explicit reveal dismissal only', () => {
    const clearCookie = buildClearOrgRevealCookie('launch-team');

    expect(clearCookie).toContain('innies_org_reveal=');
    expect(clearCookie).toContain('Path=/launch-team');
    expect(clearCookie).toContain('HttpOnly');
    expect(clearCookie).toContain('Max-Age=0');
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
