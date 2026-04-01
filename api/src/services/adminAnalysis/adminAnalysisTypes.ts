import type { NormalizedArchiveMessage } from '../archive/archiveTypes.js';

export type AdminAnalysisTaskCategory =
  | 'debugging'
  | 'feature_building'
  | 'code_review'
  | 'research'
  | 'ops'
  | 'writing'
  | 'data_analysis'
  | 'other';

export type AdminAnalysisRequestSignals = {
  isRetry: boolean;
  isFailure: boolean;
  isPartial: boolean;
  isHighToken: boolean;
  isCrossProviderRescue: boolean;
  hasToolUse: boolean;
};

export type AssistantPreviewInput = {
  responseMessages: NormalizedArchiveMessage[];
  rawResponse?: string | null;
};

export type RequestSignalsInput = {
  attemptNo: number;
  status: 'success' | 'failed' | 'partial';
  inputTokens: number;
  outputTokens: number;
  requestMessages: NormalizedArchiveMessage[];
  responseMessages: NormalizedArchiveMessage[];
  providerFallbackFrom?: string | null;
};

export type AdminAnalysisProjectionCandidate = {
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId: string | null;
  source: string;
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'partial';
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  providerFallbackFrom?: string | null;
  requestMessages: NormalizedArchiveMessage[];
  responseMessages: NormalizedArchiveMessage[];
  rawResponse?: string | null;
};
