import type { ApiKeyRepository } from '../../repos/apiKeyRepository.js';
import type { SqlClient } from '../../repos/sqlClient.js';

export type PublicLiveSessionEntry =
  | {
    entryId: string;
    kind: 'user' | 'assistant_final';
    at: string;
    text: string;
  };

export type PublicLiveSession = {
  sessionKey: string;
  sessionType: 'cli' | 'openclaw';
  displayTitle: string;
  startedAt: string;
  endedAt: string;
  lastActivityAt: string;
  currentProvider: string | null;
  currentModel: string | null;
  providerSet: string[];
  modelSet: string[];
  entries: PublicLiveSessionEntry[];
};

export type PublicLiveSessionsFeed = {
  orgSlug: string;
  generatedAt: string;
  pollIntervalSeconds: number;
  idleTimeoutSeconds: number;
  historyWindowSeconds: number;
  sessions: PublicLiveSession[];
};

export type PublicLiveSessionsServiceDeps = {
  sql: Pick<SqlClient, 'query'>;
  apiKeys: Pick<ApiKeyRepository, 'findIdByHash'>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};
