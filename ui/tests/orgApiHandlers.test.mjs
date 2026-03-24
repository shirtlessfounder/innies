import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');

function readSource(relativePath) {
  return readFileSync(join(uiRoot, relativePath), 'utf8');
}

async function importUiModule(relativePath) {
  const target = pathToFileURL(join(uiRoot, relativePath)).href;
  return import(`${target}?t=${Date.now()}-${Math.random()}`);
}

async function withMockFetch(factory, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url;
    calls.push({
      url: href,
      init: init ?? {},
    });
    return factory(href, init ?? {}, calls.length - 1);
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function readJson(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    status: init?.status,
  });
}

test('org create proxy forwards upstream status, body, cookie, and request payload', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.test';
  const { POST } = await importUiModule('src/app/api/orgs/create/route.ts');

  await withMockFetch(
    () =>
      jsonResponse(
        { orgSlug: 'acme' },
        {
          status: 201,
          headers: {
            'set-cookie': 'innies_org_reveal=secret; Path=/acme; HttpOnly',
          },
        },
      ),
    async (calls) => {
      const response = await POST(new Request('https://ui.innies.test/api/orgs/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'innies_org_session=session-token',
        },
        body: JSON.stringify({ orgName: 'Acme' }),
      }));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.innies.test/v1/orgs');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers.cookie, 'innies_org_session=session-token');
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { orgName: 'Acme' });
      assert.equal(response.status, 201);
      assert.deepEqual(await readJson(response), { orgSlug: 'acme' });
      assert.equal(response.headers.get('set-cookie'), 'innies_org_reveal=secret; Path=/acme; HttpOnly');
    },
  );
});

test('org create proxy preserves upstream error bodies without forwarding cookies', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.test';
  const { POST } = await importUiModule('src/app/api/orgs/create/route.ts');

  await withMockFetch(
    () =>
      jsonResponse(
        { kind: 'buyer_key_provisioning_failed', message: 'failed to provision' },
        { status: 502 },
      ),
    async () => {
      const response = await POST(new Request('https://ui.innies.test/api/orgs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgName: 'Acme' }),
      }));

      assert.equal(response.status, 502);
      assert.deepEqual(await readJson(response), {
        kind: 'buyer_key_provisioning_failed',
        message: 'failed to provision',
      });
      assert.equal(response.headers.get('set-cookie'), null);
    },
  );
});

test('org action proxies forward the expected upstream path and preserve JSON responses', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.test';

  const cases = [
    {
      label: 'invite create',
      modulePath: 'src/app/api/orgs/[orgSlug]/invites/route.ts',
      requestUrl: 'https://ui.innies.test/api/orgs/acme/invites',
      upstreamUrl: 'https://api.innies.test/v1/orgs/acme/invites',
      body: { githubLogin: 'octocat' },
      status: 201,
      responseBody: { kind: 'invite_created', inviteId: 'invite_123', createdFresh: true },
    },
    {
      label: 'invite revoke',
      modulePath: 'src/app/api/orgs/[orgSlug]/invites/revoke/route.ts',
      requestUrl: 'https://ui.innies.test/api/orgs/acme/invites/revoke',
      upstreamUrl: 'https://api.innies.test/v1/orgs/acme/invites/revoke',
      body: { inviteId: 'invite_123' },
      status: 200,
      responseBody: { inviteId: 'invite_123', status: 'revoked' },
    },
    {
      label: 'leave',
      modulePath: 'src/app/api/orgs/[orgSlug]/leave/route.ts',
      requestUrl: 'https://ui.innies.test/api/orgs/acme/leave',
      upstreamUrl: 'https://api.innies.test/v1/orgs/acme/leave',
      body: {},
      status: 200,
      responseBody: { membershipId: 'membership_123', redirectTo: '/' },
    },
    {
      label: 'member remove',
      modulePath: 'src/app/api/orgs/[orgSlug]/members/[memberUserId]/remove/route.ts',
      requestUrl: 'https://ui.innies.test/api/orgs/acme/members/user_123/remove',
      upstreamUrl: 'https://api.innies.test/v1/orgs/acme/members/user_123/remove',
      body: {},
      status: 200,
      responseBody: { membershipId: 'membership_123' },
    },
    {
      label: 'token refresh',
      modulePath: 'src/app/api/orgs/[orgSlug]/tokens/[tokenId]/refresh/route.ts',
      requestUrl: 'https://ui.innies.test/api/orgs/acme/tokens/token_123/refresh',
      upstreamUrl: 'https://api.innies.test/v1/orgs/acme/tokens/token_123/refresh',
      body: {},
      status: 200,
      responseBody: { tokenId: 'token_123', status: 'refreshed' },
    },
    {
      label: 'token remove',
      modulePath: 'src/app/api/orgs/[orgSlug]/tokens/[tokenId]/remove/route.ts',
      requestUrl: 'https://ui.innies.test/api/orgs/acme/tokens/token_123/remove',
      upstreamUrl: 'https://api.innies.test/v1/orgs/acme/tokens/token_123/remove',
      body: {},
      status: 200,
      responseBody: { tokenId: 'token_123', status: 'removed' },
    },
  ];

  for (const entry of cases) {
    const { POST } = await importUiModule(entry.modulePath);

    await withMockFetch(
      () => jsonResponse(entry.responseBody, { status: entry.status }),
      async (calls) => {
        const response = await POST(new Request(entry.requestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: 'innies_org_session=session-token',
          },
          body: JSON.stringify(entry.body),
        }));

        assert.equal(calls.length, 1, entry.label);
        assert.equal(calls[0].url, entry.upstreamUrl, entry.label);
        assert.equal(calls[0].init.method, 'POST', entry.label);
        assert.equal(calls[0].init.headers.cookie, 'innies_org_session=session-token', entry.label);
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), entry.body, entry.label);
        assert.equal(response.status, entry.status, entry.label);
        assert.deepEqual(await readJson(response), entry.responseBody, entry.label);
      },
    );
  }
});

test('invite accept proxy only forwards Set-Cookie when the upstream sends one', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.test';
  const { POST } = await importUiModule('src/app/api/orgs/[orgSlug]/invites/accept/route.ts');

  await withMockFetch(
    () =>
      jsonResponse(
        { orgSlug: 'acme' },
        {
          status: 200,
          headers: {
            'set-cookie': 'innies_org_reveal=fresh-key; Path=/acme; HttpOnly',
          },
        },
      ),
    async () => {
      const response = await POST(new Request('https://ui.innies.test/api/orgs/acme/invites/accept', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'innies_org_session=session-token',
        },
        body: JSON.stringify({}),
      }));

      assert.equal(response.status, 200);
      assert.deepEqual(await readJson(response), { orgSlug: 'acme' });
      assert.equal(response.headers.get('set-cookie'), 'innies_org_reveal=fresh-key; Path=/acme; HttpOnly');
    },
  );

  await withMockFetch(
    () => jsonResponse({ orgSlug: 'acme' }, { status: 200 }),
    async () => {
      const response = await POST(new Request('https://ui.innies.test/api/orgs/acme/invites/accept', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'innies_org_session=session-token',
        },
        body: JSON.stringify({}),
      }));

      assert.equal(response.status, 200);
      assert.deepEqual(await readJson(response), { orgSlug: 'acme' });
      assert.equal(response.headers.get('set-cookie'), null);
    },
  );

  await withMockFetch(
    () => jsonResponse({ kind: 'invite_no_longer_valid' }, { status: 409 }),
    async () => {
      const response = await POST(new Request('https://ui.innies.test/api/orgs/acme/invites/accept', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'innies_org_session=session-token',
        },
        body: JSON.stringify({}),
      }));

      assert.equal(response.status, 409);
      assert.deepEqual(await readJson(response), { kind: 'invite_no_longer_valid' });
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('location'), null);
    },
  );
});

test('token add proxy preserves optional reserve values in the proxied payload', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.test';
  const { POST } = await importUiModule('src/app/api/orgs/[orgSlug]/tokens/add/route.ts');

  await withMockFetch(
    () => jsonResponse({ tokenId: 'token_123' }, { status: 200 }),
    async (calls) => {
      const response = await POST(new Request('https://ui.innies.test/api/orgs/acme/tokens/add', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'innies_org_session=session-token',
        },
        body: JSON.stringify({
          provider: 'openai',
          token: 'sk-test',
          fiveHourReservePercent: 15,
          sevenDayReservePercent: 35,
        }),
      }));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.innies.test/v1/orgs/acme/tokens');
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        provider: 'openai',
        token: 'sk-test',
        fiveHourReservePercent: 15,
        sevenDayReservePercent: 35,
      });
      assert.deepEqual(await readJson(response), { tokenId: 'token_123' });
    },
  );
});

test('reveal dismiss clears the org-scoped reveal cookie', async () => {
  const { POST } = await importUiModule('src/app/api/orgs/[orgSlug]/reveal/dismiss/route.ts');
  const response = await POST(new Request('https://www.innies.test/api/orgs/acme/reveal/dismiss', {
    method: 'POST',
  }));

  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  assert.match(response.headers.get('set-cookie') ?? '', /Path=\/acme/i);
});

test('org logout clears the org session cookie and redirects to root', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.computer';
  const { POST } = await importUiModule('src/app/api/orgs/session/logout/route.ts');
  const response = await POST(new Request('https://www.innies.computer/api/orgs/session/logout', {
    method: 'POST',
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://www.innies.computer/');
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  assert.match(response.headers.get('set-cookie') ?? '', /Path=\//i);
  assert.match(response.headers.get('set-cookie') ?? '', /Domain=innies\.computer/i);
});

test('org analytics proxy handlers forward the backend path and query string', async () => {
  process.env.INNIES_API_BASE_URL = 'https://api.innies.test';
  const { GET: getDashboard } = await importUiModule('src/app/api/orgs/[orgSlug]/analytics/dashboard/route.ts');
  const { GET: getSeries } = await importUiModule('src/app/api/orgs/[orgSlug]/analytics/timeseries/route.ts');

  await withMockFetch(
    (href) => {
      if (href.includes('/analytics/dashboard')) {
        return jsonResponse({ snapshotAt: '2026-03-24T00:00:00.000Z' }, { status: 200 });
      }
      return jsonResponse({ series: [] }, { status: 200 });
    },
    async (calls) => {
      const dashboardResponse = await getDashboard(
        new Request('https://ui.innies.test/api/orgs/acme/analytics/dashboard?window=24h&provider=codex'),
      );
      assert.deepEqual(await readJson(dashboardResponse), { snapshotAt: '2026-03-24T00:00:00.000Z' });

      const seriesResponse = await getSeries(
        new Request('https://ui.innies.test/api/orgs/acme/analytics/timeseries?window=24h&entityType=token&entityId=token_123&metric=usageUnits'),
      );
      assert.deepEqual(await readJson(seriesResponse), { series: [] });

      assert.equal(calls[0].url, 'https://api.innies.test/v1/orgs/acme/analytics/dashboard?window=24h&provider=codex');
      assert.equal(
        calls[1].url,
        'https://api.innies.test/v1/orgs/acme/analytics/timeseries?window=24h&entityType=token&entityId=token_123&metric=usageUnits',
      );
    },
  );
});

test('analytics client supports default and org-scoped path overrides', () => {
  const clientSource = readSource('src/lib/analytics/client.ts');

  assert.ok(clientSource.includes('dashboardPath?: string'));
  assert.ok(clientSource.includes('timeseriesPath?: string'));
  assert.ok(clientSource.includes("opts?.dashboardPath ?? '/api/analytics/dashboard'"));
  assert.ok(clientSource.includes("opts?.timeseriesPath ?? '/api/analytics/timeseries'"));
  assert.ok(clientSource.includes('fetchAnalyticsDashboard(window: AnalyticsPageWindow'));
  assert.ok(clientSource.includes('fetchAnalyticsSeries(input: {'));
});

test('analytics hooks and dashboard client plumb optional analytics paths through the client stack', () => {
  const dashboardHookSource = readSource('src/hooks/useAnalyticsDashboard.ts');
  const seriesHookSource = readSource('src/hooks/useAnalyticsSeries.ts');
  const dashboardClientSource = readSource('src/app/analytics/AnalyticsDashboardClient.tsx');

  assert.ok(dashboardHookSource.includes('dashboardPath?: string'));
  assert.ok(dashboardHookSource.includes('dashboardPath'));
  assert.ok(seriesHookSource.includes('timeseriesPath?: string'));
  assert.ok(seriesHookSource.includes('timeseriesPath'));
  assert.ok(dashboardClientSource.includes('dashboardPath?: string'));
  assert.ok(dashboardClientSource.includes('timeseriesPath?: string'));
  assert.ok(dashboardClientSource.includes('useAnalyticsDashboard'));
  assert.ok(dashboardClientSource.includes('useAnalyticsSeries'));
});
