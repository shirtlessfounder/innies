import type { SqlClient } from '../../repos/sqlClient.js';

export const MY_LIVE_SESSIONS_DEFAULT_WINDOW_HOURS = 24;
export const MY_LIVE_SESSIONS_MAX_WINDOW_HOURS = 7 * 24; // hard cap one week
export const MY_LIVE_SESSIONS_POLL_INTERVAL_SECONDS = 5;
export const MY_LIVE_SESSIONS_MAX_SESSIONS = 60;
export const MY_LIVE_SESSIONS_MAX_TURNS_PER_SESSION = 200;

export type MyLiveSessionTurnMessage = {
  side: 'request' | 'response';
  ordinal: number;
  role: string | null;
  contentType: string;
  normalizedPayload: Record<string, unknown>;
};

export type MyLiveSessionTurn = {
  archiveId: string;
  requestId: string;
  attemptNo: number;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  upstreamStatus: number | null;
  startedAt: string;
  completedAt: string | null;
  messages: MyLiveSessionTurnMessage[];
};

export type MyLiveSession = {
  sessionKey: string;
  apiKeyId: string;
  startedAt: string;
  lastActivityAt: string;
  turnCount: number;
  providerSet: string[];
  modelSet: string[];
  turns: MyLiveSessionTurn[];
};

export type MyLiveSessionsFeed = {
  generatedAt: string;
  windowHours: number;
  pollIntervalSeconds: number;
  apiKeyIds: string[];
  sessions: MyLiveSession[];
};

export type MyLiveSessionsListInput = {
  apiKeyIds: string[];
  now?: Date;
  windowHours?: number;
};

export type MyLiveSessionsServiceDeps = {
  sql: SqlClient;
};
