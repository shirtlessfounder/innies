export type AdminSessionType = 'cli' | 'openclaw';
export type AdminSessionGroupingBasis =
  | 'explicit_session_id'
  | 'explicit_run_id'
  | 'idle_gap'
  | 'request_fallback';

export type AdminRequestSource = 'openclaw' | 'cli-claude' | 'cli-codex' | 'direct';

export type AdminSessionPreviewSample = {
  promptPreview: string | null;
  responsePreview: string | null;
  latestRequestId: string;
  latestAttemptNo: number;
};

export type AdminSessionProjectionCandidate = {
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  startedAt: Date;
  completedAt: Date | null;
  requestSource: string | null;
  providerSelectionReason: string | null;
  openclawRunId: string | null;
  openclawSessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  promptPreview: string | null;
  responsePreview: string | null;
};

export type AdminSessionProjectionResult =
  | {
    outcome: 'ignored';
    reason: 'unsupported_request_source';
  }
  | {
    outcome: 'projected';
    sessionKey: string;
    sessionType: AdminSessionType;
    groupingBasis: AdminSessionGroupingBasis;
    wasNewAttempt: boolean;
  };

export type ResolvedAdminSessionGrouping = {
  sessionKey: string;
  sessionType: AdminSessionType;
  groupingBasis: AdminSessionGroupingBasis;
  sourceSessionId: string | null;
  sourceRunId: string | null;
};
