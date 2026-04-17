import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SequenceSqlClient } from './testHelpers.js';
import { LiveLaneReadService } from '../src/services/liveLanes/liveLaneReadService.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type ServerModule = typeof import('../src/server.js');

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

describe('LiveLaneReadService', () => {
  it('builds the public live feed from canonical lanes and lane events keyed by lane_id', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [
          {
            lane_id: 'lane:openclaw_session:oc_sess_2',
            session_key: 'cli:openclaw:oc_sess_2',
            latest_provider: 'openai',
            latest_model: 'gpt-5.4',
            first_event_at: '2026-04-16T16:00:00.000Z',
            last_event_at: '2026-04-16T16:00:15.000Z'
          },
          {
            lane_id: 'lane:request:req_live_1',
            session_key: 'cli:request:req_live_1',
            latest_provider: 'openai',
            latest_model: 'gpt-5.4-mini',
            first_event_at: '2026-04-16T15:58:00.000Z',
            last_event_at: '2026-04-16T15:59:00.000Z'
          }
        ],
        rowCount: 2
      },
      {
        rows: [
          {
            lane_id: 'lane:openclaw_session:oc_sess_2',
            lane_event_id: 'laneevt:22222222-2222-4222-8222-222222222222:request:1',
            event_time: '2026-04-16T16:00:00.000Z',
            side: 'request',
            role: 'user',
            ordinal: 1,
            render_text: 'first public prompt',
            render_summary: null
          },
          {
            lane_id: 'lane:openclaw_session:oc_sess_2',
            lane_event_id: 'laneevt:22222222-2222-4222-8222-222222222222:response:1',
            event_time: '2026-04-16T16:00:15.000Z',
            side: 'response',
            role: 'assistant',
            ordinal: 1,
            render_text: 'first public answer',
            render_summary: null
          },
          {
            lane_id: 'lane:request:req_live_1',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:request:1',
            event_time: '2026-04-16T15:58:00.000Z',
            side: 'request',
            role: 'user',
            ordinal: 1,
            render_text: 'request scoped prompt',
            render_summary: null
          },
          {
            lane_id: 'lane:request:req_live_1',
            lane_event_id: 'laneevt:11111111-1111-4111-8111-111111111111:response:1',
            event_time: '2026-04-16T15:59:00.000Z',
            side: 'response',
            role: 'assistant',
            ordinal: 1,
            render_text: 'request scoped answer',
            render_summary: null
          }
        ],
        rowCount: 4
      }
    ]);
    const service = new LiveLaneReadService({
      db,
      now: () => new Date('2026-04-16T16:05:00.000Z')
    });

    const feed = await service.listPublicLiveSessionsFeed();

    expect(feed).toEqual({
      generatedAt: '2026-04-16T16:05:00.000Z',
      pollIntervalSeconds: 30,
      idleTimeoutSeconds: 900,
      historyWindowSeconds: 3600,
      sessions: [
        {
          sessionKey: 'cli:openclaw:oc_sess_2',
          sessionType: 'cli',
          displayTitle: 'cli oc_sess_2',
          startedAt: '2026-04-16T16:00:00.000Z',
          lastActivityAt: '2026-04-16T16:00:15.000Z',
          currentProvider: 'openai',
          currentModel: 'gpt-5.4',
          entries: [
            {
              entryId: 'laneevt:22222222-2222-4222-8222-222222222222:request:1',
              kind: 'user',
              at: '2026-04-16T16:00:00.000Z',
              text: 'first public prompt'
            },
            {
              entryId: 'laneevt:22222222-2222-4222-8222-222222222222:response:1',
              kind: 'assistant_final',
              at: '2026-04-16T16:00:15.000Z',
              text: 'first public answer'
            }
          ]
        },
        {
          sessionKey: 'cli:request:req_live_1',
          sessionType: 'cli',
          displayTitle: 'cli req_live_1',
          startedAt: '2026-04-16T15:58:00.000Z',
          lastActivityAt: '2026-04-16T15:59:00.000Z',
          currentProvider: 'openai',
          currentModel: 'gpt-5.4-mini',
          entries: [
            {
              entryId: 'laneevt:11111111-1111-4111-8111-111111111111:request:1',
              kind: 'user',
              at: '2026-04-16T15:58:00.000Z',
              text: 'request scoped prompt'
            },
            {
              entryId: 'laneevt:11111111-1111-4111-8111-111111111111:response:1',
              kind: 'assistant_final',
              at: '2026-04-16T15:59:00.000Z',
              text: 'request scoped answer'
            }
          ]
        }
      ]
    });
    expect(new Set(feed.sessions.flatMap((session) => session.entries.map((entry) => entry.entryId))).size)
      .toBe(4);
    expect(db.queries[0]?.sql).toContain('from in_live_lanes');
    expect(db.queries[0]?.sql).toContain("session_key not like 'cli:idle:%'");
    expect(db.queries[1]?.sql).toContain('from in_live_lane_events');
    expect(db.queries[1]?.sql).toContain('where lane_id = any($1::text[])');
    expect(db.queries[1]?.sql).not.toContain('in_admin_sessions');
  });
});

describe('publicInnies route', () => {
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

  it('mounts GET /v1/public/innies/live-sessions on createApp and returns the canonical feed shape', async () => {
    const querySpy = vi.spyOn(runtimeModule.runtime.sql, 'query');
    querySpy
      .mockResolvedValueOnce({
        rows: [{
          lane_id: 'lane:openclaw_session:oc_sess_live',
          session_key: 'cli:openclaw:oc_sess_live',
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
            lane_id: 'lane:openclaw_session:oc_sess_live',
            lane_event_id: 'laneevt:33333333-3333-4333-8333-333333333333:request:1',
            event_time: '2026-04-16T16:20:00.000Z',
            side: 'request',
            role: 'user',
            ordinal: 1,
            render_text: 'server mounted prompt',
            render_summary: null
          },
          {
            lane_id: 'lane:openclaw_session:oc_sess_live',
            lane_event_id: 'laneevt:33333333-3333-4333-8333-333333333333:response:1',
            event_time: '2026-04-16T16:20:08.000Z',
            side: 'response',
            role: 'assistant',
            ordinal: 1,
            render_text: 'server mounted answer',
            render_summary: null
          }
        ],
        rowCount: 2
      } as any);

    const server = await startTestServer(serverModule);

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/public/innies/live-sessions`, {
        headers: {
          accept: 'application/json',
          origin: 'http://localhost:3000'
        }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=5, stale-while-revalidate=25');
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');

      const payload = await response.json();
      expect(payload).toEqual(expect.objectContaining({
        generatedAt: expect.any(String),
        pollIntervalSeconds: 30,
        idleTimeoutSeconds: 900,
        historyWindowSeconds: 3600,
        sessions: [
          {
            sessionKey: 'cli:openclaw:oc_sess_live',
            sessionType: 'cli',
            displayTitle: 'cli oc_sess_live',
            startedAt: '2026-04-16T16:20:00.000Z',
            lastActivityAt: '2026-04-16T16:20:08.000Z',
            currentProvider: 'openai',
            currentModel: 'gpt-5.4',
            entries: [
              {
                entryId: 'laneevt:33333333-3333-4333-8333-333333333333:request:1',
                kind: 'user',
                at: '2026-04-16T16:20:00.000Z',
                text: 'server mounted prompt'
              },
              {
                entryId: 'laneevt:33333333-3333-4333-8333-333333333333:response:1',
                kind: 'assistant_final',
                at: '2026-04-16T16:20:08.000Z',
                text: 'server mounted answer'
              }
            ]
          }
        ]
      }));
    } finally {
      await stopTestServer(server);
    }

    expect(querySpy).toHaveBeenCalledTimes(2);
  });
});
