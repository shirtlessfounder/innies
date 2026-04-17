import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SequenceSqlClient } from './testHelpers.js';
import { LiveLaneReadService } from '../src/services/liveLanes/liveLaneReadService.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type ServerModule = typeof import('../src/server.js');

const ADMIN_MONITOR_ACTIVITY_PATH = '/v1/admin/monitor/activity';

async function startTestServer(serverModule: ServerModule): Promise<Server> {
  return await new Promise<Server>((resolve) => {
    const server = createServer(serverModule.createApp());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('LiveLaneReadService admin monitor feed', () => {
  it('emits the existing monitor payload shape from canonical lanes/events plus real archive attempts', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          lane_id: 'lane:openclaw_session:oc_sess_live',
          session_key: 'cli:openclaw:oc_sess_live',
          latest_provider: 'openai',
          latest_model: 'gpt-5.4',
          first_event_at: '2026-04-16T16:00:00.000Z',
          last_event_at: '2026-04-16T16:00:12.000Z'
        }],
        rowCount: 1
      },
      {
        rows: [
          {
            lane_id: 'lane:openclaw_session:oc_sess_live',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:request:1',
            event_time: '2026-04-16T16:00:00.000Z',
            side: 'request',
            role: 'user',
            ordinal: 1,
            render_text: 'live prompt',
            render_summary: null
          },
          {
            lane_id: 'lane:openclaw_session:oc_sess_live',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:response:1',
            event_time: '2026-04-16T16:00:12.000Z',
            side: 'response',
            role: 'assistant',
            ordinal: 1,
            render_text: 'live answer',
            render_summary: null
          }
        ],
        rowCount: 2
      }
    ]);
    const archiveReader = {
      getMonitorArchiveAttempts: vi.fn().mockResolvedValue([
        {
          requestAttemptArchiveId: '22222222-2222-4222-8222-222222222222',
          requestId: 'req_archive_1',
          attemptNo: 1,
          provider: 'openai',
          model: 'gpt-5.4',
          promptPreview: 'archived prompt',
          responsePreview: 'archived answer',
          requestLoggedAt: '2026-04-16T15:59:40.000Z',
          routedAt: '2026-04-16T15:59:48.000Z',
          upstreamStatus: 200,
          errorCode: null,
          routeDecision: {
            openclaw_session_id: 'oc_sess_live',
            request_source: 'cli-codex',
            provider_selection_reason: 'cli_provider_pinned'
          }
        }
      ])
    };
    const service = new LiveLaneReadService({
      db,
      archiveReader,
      now: () => new Date('2026-04-16T16:05:00.000Z')
    });

    const payload = await service.listAdminMonitorActivityFeed();

    expect(payload.generatedAt).toBe('2026-04-16T16:05:00.000Z');
    expect(payload.liveStatus).toBe('live');
    expect(payload.items).toHaveLength(7);
    expect(payload.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'live-session:cli:openclaw:oc_sess_live',
      'laneevt:11111111-1111-4111-8111-111111111111:request:1',
      'laneevt:11111111-1111-4111-8111-111111111111:response:1',
      'archive-session:cli:openclaw:oc_sess_live',
      'archive-request:22222222-2222-4222-8222-222222222222',
      'archive-response:22222222-2222-4222-8222-222222222222',
      'archive-attempt:22222222-2222-4222-8222-222222222222'
    ]));
    expect(new Set(payload.items.map((item) => item.stream))).toEqual(
      new Set(['live_sessions', 'latest_prompts', 'archive_trail'])
    );
    expect(payload.items.every((item) => item.sessionKey === 'cli:openclaw:oc_sess_live')).toBe(true);
    expect(new Set(payload.items.map((item) => item.id)).size).toBe(payload.items.length);
    expect(payload.items.find((item) => item.id === 'archive-session:cli:openclaw:oc_sess_live')).toEqual({
      id: 'archive-session:cli:openclaw:oc_sess_live',
      stream: 'archive_trail',
      kind: 'session',
      occurredAt: '2026-04-16T15:59:48.000Z',
      title: 'cli:openclaw:oc_sess_live',
      detail: 'archived prompt',
      sessionKey: 'cli:openclaw:oc_sess_live',
      sessionType: 'openclaw',
      provider: 'openai',
      model: 'gpt-5.4',
      status: 'completed',
      href: null
    });
    expect(archiveReader.getMonitorArchiveAttempts).toHaveBeenCalledWith({
      since: new Date('2026-04-09T16:05:00.000Z'),
      limit: 36
    });
    expect(db.queries[0]?.sql).toContain('from in_live_lanes');
    expect(db.queries[1]?.sql).toContain('from in_live_lane_events');
  });
});

describe('admin monitor route', () => {
  let runtimeModule: RuntimeModule;
  let serverModule: ServerModule;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64
      || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    serverModule = await import('../src/server.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts GET /v1/admin/monitor/activity with admin auth and preserves the public live route', async () => {
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: 'admin_key_1',
      org_id: 'org_admin',
      scope: 'admin',
      name: 'admin',
      preferred_provider: null,
      is_frozen: false
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);

    const querySpy = vi.spyOn(runtimeModule.runtime.sql, 'query');
    querySpy
      .mockResolvedValueOnce({
        rows: [{
          lane_id: 'lane:openclaw_session:oc_sess_route',
          session_key: 'cli:openclaw:oc_sess_route',
          latest_provider: 'openai',
          latest_model: 'gpt-5.4',
          first_event_at: '2026-04-16T16:20:00.000Z',
          last_event_at: '2026-04-16T16:20:08.000Z'
        }],
        rowCount: 1
      } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            lane_id: 'lane:openclaw_session:oc_sess_route',
            lane_event_id: 'laneevt:33333333-3333-4333-8333-333333333333:request:1',
            event_time: '2026-04-16T16:20:00.000Z',
            side: 'request',
            role: 'user',
            ordinal: 1,
            render_text: 'route prompt',
            render_summary: null
          },
          {
            lane_id: 'lane:openclaw_session:oc_sess_route',
            lane_event_id: 'laneevt:33333333-3333-4333-8333-333333333333:response:1',
            event_time: '2026-04-16T16:20:08.000Z',
            side: 'response',
            role: 'assistant',
            ordinal: 1,
            render_text: 'route answer',
            render_summary: null
          }
        ],
        rowCount: 2
      } as any)
      .mockResolvedValueOnce({
        rows: [{
          lane_id: 'lane:request:req_public_1',
          session_key: 'cli:request:req_public_1',
          latest_provider: 'openai',
          latest_model: 'gpt-5.4-mini',
          first_event_at: '2026-04-16T16:25:00.000Z',
          last_event_at: '2026-04-16T16:25:06.000Z'
        }],
        rowCount: 1
      } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            lane_id: 'lane:request:req_public_1',
            lane_event_id: 'laneevt:44444444-4444-4444-8444-444444444444:request:1',
            event_time: '2026-04-16T16:25:00.000Z',
            side: 'request',
            role: 'user',
            ordinal: 1,
            render_text: 'public prompt',
            render_summary: null
          },
          {
            lane_id: 'lane:request:req_public_1',
            lane_event_id: 'laneevt:44444444-4444-4444-8444-444444444444:response:1',
            event_time: '2026-04-16T16:25:06.000Z',
            side: 'response',
            role: 'assistant',
            ordinal: 1,
            render_text: 'public answer',
            render_summary: null
          }
        ],
        rowCount: 2
      } as any);
    const archiveSpy = vi.spyOn(runtimeModule.runtime.repos.analytics, 'getMonitorArchiveAttempts').mockResolvedValue([
      {
        requestAttemptArchiveId: '55555555-5555-4555-8555-555555555555',
        requestId: 'req_route_archive_1',
        attemptNo: 1,
        provider: 'openai',
        model: 'gpt-5.4',
        promptPreview: 'route archive prompt',
        responsePreview: 'route archive answer',
        requestLoggedAt: '2026-04-16T16:19:30.000Z',
        routedAt: '2026-04-16T16:19:42.000Z',
        upstreamStatus: 200,
        errorCode: null,
        routeDecision: {
          openclaw_session_id: 'oc_sess_route',
          request_source: 'cli-codex'
        }
      }
    ]);

    const server = await startTestServer(serverModule);

    try {
      const address = server.address() as AddressInfo;

      const adminResponse = await fetch(`http://127.0.0.1:${address.port}${ADMIN_MONITOR_ACTIVITY_PATH}`, {
        headers: {
          accept: 'application/json',
          'x-api-key': 'admin-token'
        }
      });

      expect(adminResponse.status).toBe(200);
      expect(adminResponse.headers.get('cache-control')).toBe('no-store');

      const adminPayload = await adminResponse.json();
      expect(adminPayload).toEqual(expect.objectContaining({
        generatedAt: expect.any(String),
        liveStatus: 'live',
        items: expect.any(Array)
      }));
      expect(new Set(adminPayload.items.map((item: { id: string }) => item.id)).size).toBe(adminPayload.items.length);
      expect(new Set(adminPayload.items.map((item: { stream: string }) => item.stream))).toEqual(
        new Set(['live_sessions', 'latest_prompts', 'archive_trail'])
      );
      expect(adminPayload.items.find((item: { id: string }) => item.id === 'archive-session:cli:openclaw:oc_sess_route'))
        .toEqual(expect.objectContaining({
          sessionKey: 'cli:openclaw:oc_sess_route',
          sessionType: 'openclaw'
        }));

      const publicResponse = await fetch(`http://127.0.0.1:${address.port}/v1/public/innies/live-sessions`, {
        headers: {
          accept: 'application/json',
          origin: 'http://localhost:3000'
        }
      });

      expect(publicResponse.status).toBe(200);
      const publicPayload = await publicResponse.json();
      expect(publicPayload.sessions).toEqual([
        expect.objectContaining({
          sessionKey: 'cli:request:req_public_1'
        })
      ]);
    } finally {
      await stopTestServer(server);
    }

    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledTimes(4);
  });
});
