import type {
  AdminAnalysisRequestRepository,
  AdminAnalysisSessionRollupRow
} from '../../repos/adminAnalysisRequestRepository.js';
import type { AdminAnalysisSessionRepository } from '../../repos/adminAnalysisSessionRepository.js';
import type { AdminSessionAttemptRepository, AdminSessionAttemptRow } from '../../repos/adminSessionAttemptRepository.js';
import type { AdminSessionRepository, AdminSessionRow } from '../../repos/adminSessionRepository.js';
import type { SqlClient } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';
import type { NormalizedArchiveMessage } from '../archive/archiveTypes.js';
import { decodeArchiveRawBlob } from '../archive/archiveCodec.js';
import { classifyAnalyticsSource } from '../../utils/analytics.js';
import type { AdminAnalysisProjectionCandidate } from './adminAnalysisTypes.js';
import {
  classifyTaskCategory,
  deriveAssistantTextPreview,
  deriveInterestingnessScore,
  deriveRequestSignals,
  deriveTaskTags,
  deriveUserMessagePreview
} from './adminAnalysisDerivation.js';

type CandidateLoader = {
  loadCandidateByArchiveId(requestAttemptArchiveId: string): Promise<AdminAnalysisProjectionCandidate | null>;
};

export class RetryableProjectionDependencyError extends Error {}

type AdminAnalysisProjectionResult =
  | {
    outcome: 'ignored';
    reason: 'unsupported_request_source';
    requestAttemptArchiveId: string;
  }
  | {
    outcome: 'projected';
    sessionKey: string;
    requestAttemptArchiveId: string;
  };

export class AdminAnalysisProjectorService {
  constructor(private readonly deps: {
    candidateLoader?: CandidateLoader;
    sql?: Pick<SqlClient, 'query'>;
    requestRepo: Pick<AdminAnalysisRequestRepository, 'upsertRequest' | 'loadSessionRollup'>;
    sessionAnalysisRepo: Pick<AdminAnalysisSessionRepository, 'upsertSession'>;
    sessionAttemptRepo: Pick<AdminSessionAttemptRepository, 'findByArchiveId'>;
    adminSessionRepo: Pick<AdminSessionRepository, 'findBySessionKey'>;
  }) {
    this.candidateLoader = deps.candidateLoader ?? createSqlCandidateLoader(deps.sql);
  }

  private readonly candidateLoader: CandidateLoader;

  async projectQueuedAttempt(
    outboxRow: Pick<AdminSessionAttemptRow, 'request_attempt_archive_id'>
  ): Promise<AdminAnalysisProjectionResult> {
    const candidate = await this.candidateLoader.loadCandidateByArchiveId(outboxRow.request_attempt_archive_id);
    if (!candidate) {
      throw new Error(`admin analysis projection candidate not found: ${outboxRow.request_attempt_archive_id}`);
    }

    if (candidate.source === 'direct') {
      return {
        outcome: 'ignored',
        reason: 'unsupported_request_source',
        requestAttemptArchiveId: candidate.requestAttemptArchiveId
      };
    }

    const sessionAttempt = await this.deps.sessionAttemptRepo.findByArchiveId(candidate.requestAttemptArchiveId);
    if (!sessionAttempt) {
      throw new RetryableProjectionDependencyError(
        `admin analysis projection waiting for admin session projection: ${candidate.requestAttemptArchiveId}`
      );
    }

    const session = await this.deps.adminSessionRepo.findBySessionKey(sessionAttempt.session_key);
    if (!session) {
      throw new RetryableProjectionDependencyError(
        `admin analysis projection waiting for admin session row: ${sessionAttempt.session_key}`
      );
    }

    const requestRow = await this.projectRequest(candidate, sessionAttempt, session);
    const rollup = await this.deps.requestRepo.loadSessionRollup(session.session_key);
    if (!rollup) {
      throw new Error(`admin analysis rollup not found after projecting request: ${session.session_key}`);
    }
    await this.deps.sessionAnalysisRepo.upsertSession(mapSessionRollup(rollup));

    return {
      outcome: 'projected',
      sessionKey: session.session_key,
      requestAttemptArchiveId: requestRow.request_attempt_archive_id
    };
  }

  private projectRequest(
    candidate: AdminAnalysisProjectionCandidate,
    sessionAttempt: Pick<AdminSessionAttemptRow, 'session_key'>,
    session: Pick<AdminSessionRow, 'session_type' | 'grouping_basis'>
  ) {
    const userMessagePreview = deriveUserMessagePreview(candidate.requestMessages);
    const assistantTextPreview = deriveAssistantTextPreview({
      responseMessages: candidate.responseMessages,
      rawResponse: candidate.rawResponse
    });
    const taskCategory = classifyTaskCategory({
      userMessagePreview,
      assistantTextPreview
    });
    const taskTags = deriveTaskTags({
      userMessagePreview,
      assistantTextPreview
    });
    const signals = deriveRequestSignals({
      attemptNo: candidate.attemptNo,
      status: candidate.status,
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      requestMessages: candidate.requestMessages,
      responseMessages: candidate.responseMessages,
      providerFallbackFrom: candidate.providerFallbackFrom ?? null
    });

    return this.deps.requestRepo.upsertRequest({
      requestAttemptArchiveId: candidate.requestAttemptArchiveId,
      requestId: candidate.requestId,
      attemptNo: candidate.attemptNo,
      sessionKey: sessionAttempt.session_key,
      orgId: candidate.orgId,
      apiKeyId: candidate.apiKeyId,
      sessionType: session.session_type,
      groupingBasis: session.grouping_basis,
      source: candidate.source,
      provider: candidate.provider,
      model: candidate.model,
      status: candidate.status,
      startedAt: candidate.startedAt,
      completedAt: candidate.completedAt,
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      userMessagePreview,
      assistantTextPreview,
      taskCategory,
      taskTags,
      ...signals,
      interestingnessScore: deriveInterestingnessScore(signals)
    });
  }
}

type ProjectionCandidateRow = {
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  api_key_id: string | null;
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'partial';
  started_at: string;
  completed_at: string | null;
  route_decision: Record<string, unknown> | null;
  input_tokens: number;
  output_tokens: number;
};

type ProjectionMessageRow = {
  side: 'request' | 'response';
  normalized_payload: NormalizedArchiveMessage;
};

type RawResponseRow = {
  blob_role: 'response' | 'stream';
  encoding: 'gzip' | 'none';
  payload: Buffer;
};

function mapSessionRollup(row: AdminAnalysisSessionRollupRow) {
  return {
    sessionKey: row.session_key,
    orgId: row.org_id,
    sessionType: row.session_type,
    groupingBasis: row.grouping_basis,
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    lastActivityAt: new Date(row.last_activity_at),
    requestCount: parseIntegerLike(row.request_count, 'request_count'),
    attemptCount: parseIntegerLike(row.attempt_count, 'attempt_count'),
    inputTokens: parseIntegerLike(row.input_tokens, 'input_tokens'),
    outputTokens: parseIntegerLike(row.output_tokens, 'output_tokens'),
    primaryTaskCategory: row.primary_task_category,
    taskCategoryBreakdown: row.task_category_breakdown,
    taskTagSet: [...row.task_tag_set],
    isLongSession: row.is_long_session,
    isHighTokenSession: row.is_high_token_session,
    isRetryHeavySession: row.is_retry_heavy_session,
    isCrossProviderSession: row.is_cross_provider_session,
    isMultiModelSession: row.is_multi_model_session,
    interestingnessScore: parseIntegerLike(row.interestingness_score, 'interestingness_score')
  };
}

function parseIntegerLike(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`expected ${field} to be a safe integer`);
  }
  return parsed;
}

function createSqlCandidateLoader(sql: Pick<SqlClient, 'query'> | undefined): CandidateLoader {
  if (!sql) {
    return {
      async loadCandidateByArchiveId() {
        throw new Error('admin analysis projector candidate loader is not configured');
      }
    };
  }

  return {
    async loadCandidateByArchiveId(requestAttemptArchiveId: string) {
      const candidateQuery = `
        select
          a.id as request_attempt_archive_id,
          a.request_id,
          a.attempt_no,
          a.org_id,
          a.api_key_id,
          a.provider,
          a.model,
          a.status,
          a.started_at,
          a.completed_at,
          re.route_decision,
          coalesce(ul.input_tokens, 0) as input_tokens,
          coalesce(ul.output_tokens, 0) as output_tokens
        from ${TABLES.requestAttemptArchives} a
        left join ${TABLES.routingEvents} re
          on re.org_id = a.org_id
          and re.request_id = a.request_id
          and re.attempt_no = a.attempt_no
        left join ${TABLES.usageLedger} ul
          on ul.org_id = a.org_id
          and ul.request_id = a.request_id
          and ul.attempt_no = a.attempt_no
          and ul.entry_type = 'usage'
        where a.id = $1
        limit 1
      `;
      const candidateResult = await sql.query<ProjectionCandidateRow>(candidateQuery, [requestAttemptArchiveId]);
      const row = candidateResult.rows[0];
      if (!row) {
        return null;
      }

      const messagesQuery = `
        select
          ram.side,
          mb.normalized_payload
        from ${TABLES.requestAttemptMessages} ram
        inner join ${TABLES.messageBlobs} mb
          on mb.id = ram.message_blob_id
        where ram.request_attempt_archive_id = $1
        order by
          case ram.side when 'request' then 0 when 'response' then 1 else 2 end asc,
          ram.ordinal asc
      `;
      const messageResult = await sql.query<ProjectionMessageRow>(messagesQuery, [requestAttemptArchiveId]);
      const requestMessages: NormalizedArchiveMessage[] = [];
      const responseMessages: NormalizedArchiveMessage[] = [];
      for (const message of messageResult.rows) {
        const normalized = message.normalized_payload;
        if (message.side === 'request') {
          requestMessages.push(normalized);
        } else {
          responseMessages.push(normalized);
        }
      }

      const rawQuery = `
        select
          rab.blob_role,
          rb.encoding,
          rb.payload
        from ${TABLES.requestAttemptRawBlobs} rab
        inner join ${TABLES.rawBlobs} rb
          on rb.id = rab.raw_blob_id
        where rab.request_attempt_archive_id = $1
          and rab.blob_role in ('response', 'stream')
        order by case rab.blob_role when 'response' then 0 else 1 end asc
      `;
      const rawResult = await sql.query<RawResponseRow>(rawQuery, [requestAttemptArchiveId]);
      const rawResponse = rawResult.rows[0]
        ? decodeArchiveRawBlob({
          encoding: rawResult.rows[0].encoding,
          payload: rawResult.rows[0].payload
        }).toString('utf8')
        : null;

      return {
        requestAttemptArchiveId: row.request_attempt_archive_id,
        requestId: row.request_id,
        attemptNo: row.attempt_no,
        orgId: row.org_id,
        apiKeyId: row.api_key_id,
        source: classifyAnalyticsSource({
          provider: row.provider,
          routeDecision: row.route_decision
        }),
        provider: row.provider,
        model: row.model,
        status: row.status,
        startedAt: new Date(row.started_at),
        completedAt: row.completed_at ? new Date(row.completed_at) : null,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        providerFallbackFrom: readString(row.route_decision?.provider_fallback_from),
        requestMessages,
        responseMessages,
        rawResponse
      } satisfies AdminAnalysisProjectionCandidate;
    }
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
