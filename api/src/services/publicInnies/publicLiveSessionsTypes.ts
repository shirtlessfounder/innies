import type { ApiKeyRepository } from '../../repos/apiKeyRepository.js';
import type { SqlClient } from '../../repos/sqlClient.js';

export type PublicLiveSessionEntry =
  | {
    kind: 'user' | 'assistant_final';
    at: string;
    text: string;
  }
  | {
    kind: 'tool_call';
    at: string;
    toolCallId: string | null;
    toolName: string | null;
    payloadText: string;
  }
  | {
    kind: 'tool_result';
    at: string;
    toolUseId: string | null;
    payloadText: string;
  }
  | {
    kind: 'provider_switch';
    at: string;
    fromProvider: string | null;
    toProvider: string;
    reason: string | null;
  };

export type PublicLiveSession = {
  sessionKey: string;
  sessionType: 'cli' | 'openclaw';
  startedAt: string;
  endedAt: string;
  lastActivityAt: string;
  providerSet: string[];
  modelSet: string[];
  entries: PublicLiveSessionEntry[];
};

export type PublicLiveSessionsFeed = {
  orgSlug: string;
  generatedAt: string;
  sessions: PublicLiveSession[];
};

export type PublicLiveSessionsServiceDeps = {
  sql: Pick<SqlClient, 'query'>;
  apiKeys: Pick<ApiKeyRepository, 'findIdByHash'>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};
