import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { TransactionContext } from '../src/repos/sqlClient.js';
import type {
  ArchiveAttemptInput,
  RequestArchiveServiceRepoFactory,
  RequestArchiveServiceResult
} from '../src/services/archive/archiveTypes.js';
import { hashNormalizedPayload } from '../src/services/archive/archiveHash.js';
import { RequestArchiveService } from '../src/services/archive/requestArchiveService.js';

type AttemptRecord = {
  id: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId: string | null;
  routeKind: 'seller_key' | 'token_credential';
  sellerKeyId: string | null;
  tokenCredentialId: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  upstreamStatus: number | null;
  errorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  openclawRunId: string | null;
  openclawSessionId: string | null;
  routingEventId: string | null;
  usageLedgerId: string | null;
  meteringEventId: string | null;
};

type MessageBlobRecord = {
  id: string;
  contentHash: string;
  kind: 'message' | 'part';
  role: string | null;
  contentType: string;
  normalizedPayload: Record<string, unknown>;
  normalizedPayloadCodecVersion: number;
};

type AttemptMessageRecord = {
  requestAttemptArchiveId: string;
  side: 'request' | 'response';
  ordinal: number;
  messageBlobId: string;
  role: string | null;
  contentType: string;
};

type RawBlobRecord = {
  id: string;
  contentHash: string;
  blobKind: 'raw_request' | 'raw_response' | 'raw_stream';
  encoding: 'gzip' | 'none';
  bytesCompressed: number;
  bytesUncompressed: number;
  payload: Buffer;
};

type AttemptRawBlobRecord = {
  requestAttemptArchiveId: string;
  blobRole: 'request' | 'response' | 'stream';
  rawBlobId: string;
};

type SessionProjectionOutboxRecord = {
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId: string | null;
};

type AnalysisProjectionOutboxRecord = {
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId: string | null;
};

type HarnessState = {
  attempts: AttemptRecord[];
  messageBlobs: MessageBlobRecord[];
  attemptMessages: AttemptMessageRecord[];
  rawBlobs: RawBlobRecord[];
  attemptRawBlobs: AttemptRawBlobRecord[];
  sessionProjectionOutbox: SessionProjectionOutboxRecord[];
  analysisProjectionOutbox: AnalysisProjectionOutboxRecord[];
};

type HarnessTx = TransactionContext & {
  __state: HarnessState;
};

function createArchiveHarness(options?: {
  failOnRawBlobKind?: 'raw_request' | 'raw_response' | 'raw_stream';
  failOnOutbox?: boolean;
  failOnAnalysisOutbox?: boolean;
}): {
  sql: {
    transaction<T>(run: (tx: HarnessTx) => Promise<T>): Promise<T>;
  };
  repoFactory: RequestArchiveServiceRepoFactory;
  state: HarnessState;
} {
  const state: HarnessState = {
    attempts: [],
    messageBlobs: [],
    attemptMessages: [],
    rawBlobs: [],
    attemptRawBlobs: [],
    sessionProjectionOutbox: [],
    analysisProjectionOutbox: []
  };

  const sql = {
    async transaction<T>(run: (tx: HarnessTx) => Promise<T>): Promise<T> {
      const draft = cloneState(state);
      const tx = {
        __state: draft,
        async query() {
          return { rows: [], rowCount: 0 };
        }
      } satisfies HarnessTx;

      const result = await run(tx);
      state.attempts = draft.attempts;
      state.messageBlobs = draft.messageBlobs;
      state.attemptMessages = draft.attemptMessages;
      state.rawBlobs = draft.rawBlobs;
      state.attemptRawBlobs = draft.attemptRawBlobs;
      state.sessionProjectionOutbox = draft.sessionProjectionOutbox;
      state.analysisProjectionOutbox = draft.analysisProjectionOutbox;
      return result;
    }
  };

  const repoFactory: RequestArchiveServiceRepoFactory = {
    requestAttemptArchives(tx) {
      return {
        async upsertArchive(input) {
          const stateRef = readState(tx);
          const existing = stateRef.attempts.find((candidate) =>
            candidate.orgId === input.orgId
            && candidate.requestId === input.requestId
            && candidate.attemptNo === input.attemptNo
          );
          if (existing) {
            assertAttemptReplayMatches(existing, input);
            return toAttemptRow(existing);
          }

          const record: AttemptRecord = {
            id: `archive_${stateRef.attempts.length + 1}`,
            requestId: input.requestId,
            attemptNo: input.attemptNo,
            orgId: input.orgId,
            apiKeyId: input.apiKeyId ?? null,
            routeKind: input.routeKind,
            sellerKeyId: input.sellerKeyId ?? null,
            tokenCredentialId: input.tokenCredentialId ?? null,
            provider: input.provider,
            model: input.model,
            streaming: input.streaming,
            status: input.status,
            upstreamStatus: input.upstreamStatus ?? null,
            errorCode: input.errorCode ?? null,
            startedAt: input.startedAt,
            completedAt: input.completedAt ?? null,
            openclawRunId: input.openclawRunId ?? null,
            openclawSessionId: input.openclawSessionId ?? null,
            routingEventId: input.routingEventId ?? null,
            usageLedgerId: input.usageLedgerId ?? null,
            meteringEventId: input.meteringEventId ?? null
          };
          stateRef.attempts.push(record);
          return toAttemptRow(record);
        }
      };
    },
    messageBlobs(tx) {
      return {
        async upsertBlob(input) {
          const stateRef = readState(tx);
          const existing = stateRef.messageBlobs.find((candidate) => candidate.contentHash === input.contentHash);
          if (existing) {
            return toMessageBlobRow(existing);
          }

          const record: MessageBlobRecord = {
            id: `blob_${stateRef.messageBlobs.length + 1}`,
            contentHash: input.contentHash,
            kind: input.kind,
            role: input.role ?? null,
            contentType: input.contentType,
            normalizedPayload: input.normalizedPayload,
            normalizedPayloadCodecVersion: input.normalizedPayloadCodecVersion ?? 1
          };
          stateRef.messageBlobs.push(record);
          return toMessageBlobRow(record);
        }
      };
    },
    requestAttemptMessages(tx) {
      return {
        async upsertLinks(input) {
          const stateRef = readState(tx);
          for (const link of input) {
            const existing = stateRef.attemptMessages.find((candidate) =>
              candidate.requestAttemptArchiveId === link.requestAttemptArchiveId
              && candidate.side === link.side
              && candidate.ordinal === link.ordinal
            );
            if (existing) continue;
            stateRef.attemptMessages.push({
              requestAttemptArchiveId: link.requestAttemptArchiveId,
              side: link.side,
              ordinal: link.ordinal,
              messageBlobId: link.messageBlobId,
              role: link.role ?? null,
              contentType: link.contentType
            });
          }
        }
      };
    },
    rawBlobs(tx) {
      return {
        async upsertBlob(input) {
          if (options?.failOnRawBlobKind === input.blobKind) {
            throw new Error(`forced raw blob failure: ${input.blobKind}`);
          }

          const stateRef = readState(tx);
          const existing = stateRef.rawBlobs.find((candidate) =>
            candidate.contentHash === input.contentHash
            && candidate.blobKind === input.blobKind
          );
          if (existing) {
            return toRawBlobRow(existing);
          }

          const record: RawBlobRecord = {
            id: `raw_${stateRef.rawBlobs.length + 1}`,
            contentHash: input.contentHash,
            blobKind: input.blobKind,
            encoding: input.encoding,
            bytesCompressed: input.bytesCompressed,
            bytesUncompressed: input.bytesUncompressed,
            payload: Buffer.from(input.payload)
          };
          stateRef.rawBlobs.push(record);
          return toRawBlobRow(record);
        }
      };
    },
    requestAttemptRawBlobs(tx) {
      return {
        async upsertLink(input) {
          const stateRef = readState(tx);
          const existing = stateRef.attemptRawBlobs.find((candidate) =>
            candidate.requestAttemptArchiveId === input.requestAttemptArchiveId
            && candidate.blobRole === input.blobRole
          );
          if (existing) {
            return {
              request_attempt_archive_id: existing.requestAttemptArchiveId,
              blob_role: existing.blobRole,
              raw_blob_id: existing.rawBlobId,
              created_at: new Date().toISOString()
            };
          }

          const record: AttemptRawBlobRecord = {
            requestAttemptArchiveId: input.requestAttemptArchiveId,
            blobRole: input.blobRole,
            rawBlobId: input.rawBlobId
          };
          stateRef.attemptRawBlobs.push(record);
          return {
            request_attempt_archive_id: record.requestAttemptArchiveId,
            blob_role: record.blobRole,
            raw_blob_id: record.rawBlobId,
            created_at: new Date().toISOString()
          };
        }
      };
    },
    sessionProjectionOutbox(tx) {
      return {
        async enqueueAttempt(input) {
          if (options?.failOnOutbox) {
            throw new Error('forced outbox failure');
          }

          const stateRef = readState(tx);
          const existing = stateRef.sessionProjectionOutbox.find((candidate) =>
            candidate.requestAttemptArchiveId === input.requestAttemptArchiveId
          );
          if (existing) {
            assertSessionProjectionReplayMatches(existing, input);
            return {
              id: `outbox_${stateRef.sessionProjectionOutbox.indexOf(existing) + 1}`,
              request_attempt_archive_id: existing.requestAttemptArchiveId,
              request_id: existing.requestId,
              attempt_no: existing.attemptNo,
              org_id: existing.orgId,
              api_key_id: existing.apiKeyId,
              projection_state: 'pending_projection',
              retry_count: 0,
              next_attempt_at: new Date('2026-03-26T00:00:00Z').toISOString(),
              last_attempted_at: null,
              processed_at: null,
              last_error: null,
              created_at: new Date('2026-03-26T00:00:00Z').toISOString(),
              updated_at: new Date('2026-03-26T00:00:00Z').toISOString()
            };
          }

          const record: SessionProjectionOutboxRecord = {
            requestAttemptArchiveId: input.requestAttemptArchiveId,
            requestId: input.requestId,
            attemptNo: input.attemptNo,
            orgId: input.orgId,
            apiKeyId: input.apiKeyId
          };
          stateRef.sessionProjectionOutbox.push(record);
          return {
            id: `outbox_${stateRef.sessionProjectionOutbox.length}`,
            request_attempt_archive_id: record.requestAttemptArchiveId,
            request_id: record.requestId,
            attempt_no: record.attemptNo,
            org_id: record.orgId,
            api_key_id: record.apiKeyId,
            projection_state: 'pending_projection',
            retry_count: 0,
            next_attempt_at: new Date('2026-03-26T00:00:00Z').toISOString(),
            last_attempted_at: null,
            processed_at: null,
            last_error: null,
            created_at: new Date('2026-03-26T00:00:00Z').toISOString(),
            updated_at: new Date('2026-03-26T00:00:00Z').toISOString()
          };
        }
      };
    },
    analysisProjectionOutbox(tx) {
      return {
        async enqueueAttempt(input) {
          if (options?.failOnAnalysisOutbox) {
            throw new Error('forced analysis outbox failure');
          }

          const stateRef = readState(tx);
          const existing = stateRef.analysisProjectionOutbox.find((candidate) =>
            candidate.requestAttemptArchiveId === input.requestAttemptArchiveId
          );
          if (existing) {
            assertAnalysisProjectionReplayMatches(existing, input);
            return {
              id: `analysis_outbox_${stateRef.analysisProjectionOutbox.indexOf(existing) + 1}`,
              request_attempt_archive_id: existing.requestAttemptArchiveId,
              request_id: existing.requestId,
              attempt_no: existing.attemptNo,
              org_id: existing.orgId,
              api_key_id: existing.apiKeyId,
              projection_state: 'pending_projection',
              retry_count: 0,
              next_attempt_at: new Date('2026-03-26T00:00:00Z').toISOString(),
              last_attempted_at: null,
              processed_at: null,
              last_error: null,
              created_at: new Date('2026-03-26T00:00:00Z').toISOString(),
              updated_at: new Date('2026-03-26T00:00:00Z').toISOString()
            };
          }

          const record: AnalysisProjectionOutboxRecord = {
            requestAttemptArchiveId: input.requestAttemptArchiveId,
            requestId: input.requestId,
            attemptNo: input.attemptNo,
            orgId: input.orgId,
            apiKeyId: input.apiKeyId
          };
          stateRef.analysisProjectionOutbox.push(record);
          return {
            id: `analysis_outbox_${stateRef.analysisProjectionOutbox.length}`,
            request_attempt_archive_id: record.requestAttemptArchiveId,
            request_id: record.requestId,
            attempt_no: record.attemptNo,
            org_id: record.orgId,
            api_key_id: record.apiKeyId,
            projection_state: 'pending_projection',
            retry_count: 0,
            next_attempt_at: new Date('2026-03-26T00:00:00Z').toISOString(),
            last_attempted_at: null,
            processed_at: null,
            last_error: null,
            created_at: new Date('2026-03-26T00:00:00Z').toISOString(),
            updated_at: new Date('2026-03-26T00:00:00Z').toISOString()
          };
        }
      };
    }
  };

  return { sql, repoFactory, state };
}

function readState(tx: TransactionContext): HarnessState {
  return (tx as HarnessTx).__state;
}

function cloneState(state: HarnessState): HarnessState {
  return {
    attempts: state.attempts.map((record) => ({
      ...record,
      startedAt: new Date(record.startedAt),
      completedAt: record.completedAt ? new Date(record.completedAt) : null
    })),
    messageBlobs: state.messageBlobs.map((record) => ({
      ...record,
      normalizedPayload: structuredClone(record.normalizedPayload)
    })),
    attemptMessages: state.attemptMessages.map((record) => ({ ...record })),
    rawBlobs: state.rawBlobs.map((record) => ({
      ...record,
      payload: Buffer.from(record.payload)
    })),
    attemptRawBlobs: state.attemptRawBlobs.map((record) => ({ ...record })),
    sessionProjectionOutbox: state.sessionProjectionOutbox.map((record) => ({ ...record })),
    analysisProjectionOutbox: state.analysisProjectionOutbox.map((record) => ({ ...record }))
  };
}

function assertAttemptReplayMatches(existing: AttemptRecord, input: AttemptRecordLike): void {
  const mismatch = [
    existing.requestId === input.requestId,
    existing.attemptNo === input.attemptNo,
    existing.orgId === input.orgId,
    existing.apiKeyId === (input.apiKeyId ?? null),
    existing.routeKind === input.routeKind,
    existing.sellerKeyId === (input.sellerKeyId ?? null),
    existing.tokenCredentialId === (input.tokenCredentialId ?? null),
    existing.provider === input.provider,
    existing.model === input.model,
    existing.streaming === input.streaming,
    existing.status === input.status,
    existing.upstreamStatus === (input.upstreamStatus ?? null),
    existing.errorCode === (input.errorCode ?? null),
    existing.startedAt.toISOString() === input.startedAt.toISOString(),
    existing.openclawRunId === (input.openclawRunId ?? null),
    existing.openclawSessionId === (input.openclawSessionId ?? null),
    existing.routingEventId === (input.routingEventId ?? null),
    existing.usageLedgerId === (input.usageLedgerId ?? null),
    existing.meteringEventId === (input.meteringEventId ?? null)
  ].every(Boolean);

  if (!mismatch) {
    throw new Error('request attempt archive idempotent replay mismatch');
  }
}

function assertSessionProjectionReplayMatches(
  existing: SessionProjectionOutboxRecord,
  input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    orgId: string;
    apiKeyId: string | null;
  }
): void {
  const matches = existing.requestAttemptArchiveId === input.requestAttemptArchiveId
    && existing.requestId === input.requestId
    && existing.attemptNo === input.attemptNo
    && existing.orgId === input.orgId
    && existing.apiKeyId === input.apiKeyId;

  if (!matches) {
    throw new Error('admin session projection outbox idempotent replay mismatch');
  }
}

function assertAnalysisProjectionReplayMatches(
  existing: AnalysisProjectionOutboxRecord,
  input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    orgId: string;
    apiKeyId: string | null;
  }
): void {
  if (
    existing.requestAttemptArchiveId !== input.requestAttemptArchiveId
    || existing.requestId !== input.requestId
    || existing.attemptNo !== input.attemptNo
    || existing.orgId !== input.orgId
    || existing.apiKeyId !== input.apiKeyId
  ) {
    throw new Error('admin analysis projection outbox idempotent replay mismatch');
  }
}

type AttemptRecordLike = Omit<AttemptRecord, 'id'>;

function toAttemptRow(record: AttemptRecord) {
  return {
    id: record.id,
    request_id: record.requestId,
    attempt_no: record.attemptNo,
    org_id: record.orgId,
    api_key_id: record.apiKeyId,
    route_kind: record.routeKind,
    seller_key_id: record.sellerKeyId,
    token_credential_id: record.tokenCredentialId,
    provider: record.provider,
    model: record.model,
    streaming: record.streaming,
    status: record.status,
    upstream_status: record.upstreamStatus,
    error_code: record.errorCode,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    openclaw_run_id: record.openclawRunId,
    openclaw_session_id: record.openclawSessionId,
    routing_event_id: record.routingEventId,
    usage_ledger_id: record.usageLedgerId,
    metering_event_id: record.meteringEventId,
    created_at: new Date('2026-03-26T00:00:00Z')
  };
}

function toMessageBlobRow(record: MessageBlobRecord) {
  return {
    id: record.id,
    content_hash: record.contentHash,
    kind: record.kind,
    role: record.role,
    content_type: record.contentType,
    normalized_payload: record.normalizedPayload,
    normalized_payload_codec_version: record.normalizedPayloadCodecVersion,
    created_at: new Date('2026-03-26T00:00:00Z')
  };
}

function toRawBlobRow(record: RawBlobRecord) {
  return {
    id: record.id,
    content_hash: record.contentHash,
    blob_kind: record.blobKind,
    encoding: record.encoding,
    bytes_compressed: record.bytesCompressed,
    bytes_uncompressed: record.bytesUncompressed,
    payload: record.payload,
    created_at: new Date('2026-03-26T00:00:00Z')
  };
}

function createService(options?: {
  failOnRawBlobKind?: 'raw_request' | 'raw_response' | 'raw_stream';
  failOnOutbox?: boolean;
}): {
  service: RequestArchiveService;
  state: HarnessState;
} {
  const harness = createArchiveHarness(options);
  return {
    service: new RequestArchiveService({
      sql: harness.sql,
      repoFactory: harness.repoFactory
    }),
    state: harness.state
  };
}

function baseAttempt(input?: Partial<ArchiveAttemptInput>): ArchiveAttemptInput {
  return {
    requestId: 'req_1',
    attemptNo: 1,
    orgId: 'org_1',
    apiKeyId: 'api_key_1',
    routeKind: 'token_credential',
    sellerKeyId: null,
    tokenCredentialId: 'cred_1',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    streaming: false,
    status: 'success',
    upstreamStatus: 200,
    errorCode: null,
    startedAt: new Date('2026-03-26T03:00:00Z'),
    completedAt: new Date('2026-03-26T03:00:04Z'),
    openclawRunId: null,
    openclawSessionId: null,
    routingEventId: null,
    usageLedgerId: null,
    meteringEventId: null,
    request: {
      format: 'anthropic_messages',
      payload: {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hello' }]
      }
    },
    response: {
      format: 'anthropic_messages',
      payload: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }]
      }
    },
    rawRequest: JSON.stringify({ raw: 'request' }),
    rawResponse: JSON.stringify({ raw: 'response' }),
    rawStream: null,
    ...input
  };
}

function decodeBuffer(payload: Buffer): string {
  return gunzipSync(payload).toString('utf8');
}

describe('archiveHash', () => {
  it('hashes canonical normalized JSON with stable key ordering while preserving array order', () => {
    const first = {
      role: 'user',
      content: [{ type: 'json', value: { b: 2, a: 1 } }]
    };
    const sameMeaning = {
      content: [{ value: { a: 1, b: 2 }, type: 'json' }],
      role: 'user'
    };
    const differentOrder = {
      role: 'user',
      content: [
        { type: 'json', value: { a: 1, b: 2 } },
        { type: 'text', text: 'later' }
      ]
    };

    expect(hashNormalizedPayload(first)).toBe(hashNormalizedPayload(sameMeaning));
    expect(hashNormalizedPayload(first)).not.toBe(hashNormalizedPayload(differentOrder));
  });
});

describe('RequestArchiveService', () => {
  it('stores only one new message blob for repeated x,y then x,y,z request histories', async () => {
    const { service, state } = createService();

    await service.archiveAttempt(baseAttempt({
      requestId: 'req_xy',
      status: 'failed',
      upstreamStatus: 500,
      errorCode: 'upstream_error',
      response: null,
      rawResponse: null,
      request: {
        format: 'anthropic_messages',
        payload: {
          model: 'claude-3-5-sonnet-latest',
          messages: [
            { role: 'user', content: 'x' },
            { role: 'assistant', content: 'y' }
          ]
        }
      }
    }));

    expect(state.messageBlobs).toHaveLength(2);

    await service.archiveAttempt(baseAttempt({
      requestId: 'req_xyz',
      status: 'failed',
      upstreamStatus: 500,
      errorCode: 'upstream_error',
      response: null,
      rawResponse: null,
      request: {
        format: 'anthropic_messages',
        payload: {
          model: 'claude-3-5-sonnet-latest',
          messages: [
            { role: 'user', content: 'x' },
            { role: 'assistant', content: 'y' },
            { role: 'user', content: 'z' }
          ]
        }
      }
    }));

    expect(state.messageBlobs).toHaveLength(3);
    expect(state.attemptMessages.filter((record) => record.side === 'request')).toHaveLength(5);
  });

  it('reuses identical normalized message blobs across orgs', async () => {
    const { service, state } = createService();

    await service.archiveAttempt(baseAttempt({
      orgId: 'org_1',
      requestId: 'req_org_1',
      status: 'failed',
      upstreamStatus: 429,
      errorCode: 'rate_limited',
      response: null,
      rawResponse: null
    }));

    await service.archiveAttempt(baseAttempt({
      orgId: 'org_2',
      requestId: 'req_org_2',
      status: 'failed',
      upstreamStatus: 429,
      errorCode: 'rate_limited',
      response: null,
      rawResponse: null
    }));

    expect(state.messageBlobs).toHaveLength(1);
    expect(state.attempts).toHaveLength(2);
    expect(new Set(state.attemptMessages.map((record) => record.messageBlobId))).toEqual(new Set(['blob_1']));
  });

  it('persists archived api_key_id for downstream buyer-key analysis', async () => {
    const { service, state } = createService();

    await service.archiveAttempt(baseAttempt({
      requestId: 'req_api_key_archive',
      apiKeyId: 'buyer_key_analytics'
    }));

    expect(state.attempts).toEqual([
      expect.objectContaining({
        requestId: 'req_api_key_archive',
        apiKeyId: 'buyer_key_analytics'
      })
    ]);
    expect(toAttemptRow(state.attempts[0]!).api_key_id).toBe('buyer_key_analytics');
  });

  it('enqueues one session projection outbox row in the same transaction as the archive write', async () => {
    const { service, state } = createService();

    await service.archiveAttempt(baseAttempt({
      requestId: 'req_projection_enqueue',
      attemptNo: 2
    }));

    expect(state.attempts).toHaveLength(1);
    expect(state.sessionProjectionOutbox).toEqual([
      {
        requestAttemptArchiveId: 'archive_1',
        requestId: 'req_projection_enqueue',
        attemptNo: 2,
        orgId: 'org_1',
        apiKeyId: 'api_key_1'
      }
    ]);
    expect(state.analysisProjectionOutbox).toEqual([
      {
        requestAttemptArchiveId: 'archive_1',
        requestId: 'req_projection_enqueue',
        attemptNo: 2,
        orgId: 'org_1',
        apiKeyId: 'api_key_1'
      }
    ]);
  });

  it('keeps a duplicate replay from enqueueing a second projection outbox row', async () => {
    const { service, state } = createService();

    await service.archiveAttempt(baseAttempt({
      requestId: 'req_projection_replay',
      attemptNo: 3
    }));
    await service.archiveAttempt(baseAttempt({
      requestId: 'req_projection_replay',
      attemptNo: 3
    }));

    expect(state.attempts).toHaveLength(1);
    expect(state.sessionProjectionOutbox).toHaveLength(1);
    expect(state.analysisProjectionOutbox).toHaveLength(1);
    expect(state.sessionProjectionOutbox[0]).toEqual({
      requestAttemptArchiveId: 'archive_1',
      requestId: 'req_projection_replay',
      attemptNo: 3,
      orgId: 'org_1',
      apiKeyId: 'api_key_1'
    });
    expect(state.analysisProjectionOutbox[0]).toEqual({
      requestAttemptArchiveId: 'archive_1',
      requestId: 'req_projection_replay',
      attemptNo: 3,
      orgId: 'org_1',
      apiKeyId: 'api_key_1'
    });
  });

  it('tolerates duplicate archive replays when only completedAt drifts', async () => {
    const { service, state } = createService();

    await service.archiveAttempt(baseAttempt({
      requestId: 'req_completed_at_replay',
      attemptNo: 4,
      completedAt: new Date('2026-03-26T03:00:04Z')
    }));
    await service.archiveAttempt(baseAttempt({
      requestId: 'req_completed_at_replay',
      attemptNo: 4,
      completedAt: new Date('2026-03-26T03:00:09Z')
    }));

    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toEqual(expect.objectContaining({
      requestId: 'req_completed_at_replay',
      attemptNo: 4,
      completedAt: new Date('2026-03-26T03:00:04Z')
    }));
    expect(state.sessionProjectionOutbox).toHaveLength(1);
    expect(state.analysisProjectionOutbox).toHaveLength(1);
  });

  it('rolls back archive rows when either projection outbox enqueue fails', async () => {
    const { service, state } = createService({ failOnOutbox: true });

    await expect(service.archiveAttempt(baseAttempt({
      requestId: 'req_projection_rollback'
    }))).rejects.toThrow('forced outbox failure');

    expect(state.attempts).toEqual([]);
    expect(state.messageBlobs).toEqual([]);
    expect(state.attemptMessages).toEqual([]);
    expect(state.rawBlobs).toEqual([]);
    expect(state.attemptRawBlobs).toEqual([]);
    expect(state.sessionProjectionOutbox).toEqual([]);
    expect(state.analysisProjectionOutbox).toEqual([]);

    const analysisFailure = createService({ failOnAnalysisOutbox: true });

    await expect(analysisFailure.service.archiveAttempt(baseAttempt({
      requestId: 'req_analysis_projection_rollback'
    }))).rejects.toThrow('forced analysis outbox failure');

    expect(analysisFailure.state.attempts).toEqual([]);
    expect(analysisFailure.state.messageBlobs).toEqual([]);
    expect(analysisFailure.state.attemptMessages).toEqual([]);
    expect(analysisFailure.state.rawBlobs).toEqual([]);
    expect(analysisFailure.state.attemptRawBlobs).toEqual([]);
    expect(analysisFailure.state.sessionProjectionOutbox).toEqual([]);
    expect(analysisFailure.state.analysisProjectionOutbox).toEqual([]);
  });

  it('preserves first-class system, user, assistant, tool-call, tool-result, and structured JSON content', async () => {
    const { service, state } = createService();

    const result = await service.archiveAttempt(baseAttempt({
      provider: 'openai',
      model: 'gpt-5.4',
      request: {
        format: 'anthropic_messages',
        payload: {
          model: 'claude-3-5-sonnet-latest',
          system: [{ type: 'text', text: 'follow repo policy' }],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look up innies' },
                { type: 'json', data: { repo: 'innies', limit: 1 } }
              ]
            },
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'toolu_1', name: 'lookup_repo', input: { name: 'innies' } }
              ]
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'repo found' }] }
              ]
            }
          ]
        }
      },
      response: {
        format: 'openai_responses',
        payload: {
          id: 'resp_1',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'Repository located.' },
                { type: 'json', data: { full_name: 'dylanvu/innies' } }
              ]
            },
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'lookup_repo',
              arguments: '{\"name\":\"innies\"}'
            }
          ]
        }
      }
    }));

    expect(result).toEqual(expect.objectContaining({
      archiveId: 'archive_1',
      requestMessageCount: 4,
      responseMessageCount: 2
    }) satisfies Partial<RequestArchiveServiceResult>);

    expect(state.messageBlobs.map((record) => record.normalizedPayload)).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'follow repo policy' }]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look up innies' },
          { type: 'json', value: { repo: 'innies', limit: 1 } }
        ]
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'toolu_1', name: 'lookup_repo', arguments: { name: 'innies' } }]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            content: [{ type: 'text', text: 'repo found' }]
          }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Repository located.' },
          { type: 'json', value: { full_name: 'dylanvu/innies' } }
        ]
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'lookup_repo', arguments: { name: 'innies' } }]
      }
    ]);
  });

  it('archives one user request message for openai responses string input', async () => {
    const { service, state } = createService();

    const result = await service.archiveAttempt(baseAttempt({
      provider: 'openai',
      model: 'gpt-5.4',
      status: 'failed',
      upstreamStatus: 429,
      errorCode: 'capacity_unavailable',
      response: null,
      rawResponse: null,
      request: {
        format: 'openai_responses',
        payload: {
          model: 'gpt-5.4',
          input: 'hello'
        }
      }
    }));

    expect(result).toEqual(expect.objectContaining({
      requestMessageCount: 1,
      responseMessageCount: 0
    }) satisfies Partial<RequestArchiveServiceResult>);
    expect(state.attemptMessages.filter((record) => record.side === 'request')).toHaveLength(1);
    expect(state.messageBlobs.map((record) => record.normalizedPayload)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      }
    ]);
  });

  it('archives both system and user request messages for openai responses instructions plus string input', async () => {
    const { service, state } = createService();

    const result = await service.archiveAttempt(baseAttempt({
      provider: 'openai',
      model: 'gpt-5.4',
      status: 'failed',
      upstreamStatus: 429,
      errorCode: 'capacity_unavailable',
      response: null,
      rawResponse: null,
      request: {
        format: 'openai_responses',
        payload: {
          model: 'gpt-5.4',
          instructions: 'be concise',
          input: 'hello'
        }
      }
    }));

    expect(result).toEqual(expect.objectContaining({
      requestMessageCount: 2,
      responseMessageCount: 0
    }) satisfies Partial<RequestArchiveServiceResult>);
    expect(state.attemptMessages.filter((record) => record.side === 'request')).toHaveLength(2);
    expect(state.messageBlobs.map((record) => record.normalizedPayload)).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'be concise' }]
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      }
    ]);
  });

  it('archives user request messages for plain-string items inside openai responses input arrays', async () => {
    const { service, state } = createService();

    const result = await service.archiveAttempt(baseAttempt({
      provider: 'openai',
      model: 'gpt-5.4',
      status: 'failed',
      upstreamStatus: 429,
      errorCode: 'capacity_unavailable',
      response: null,
      rawResponse: null,
      request: {
        format: 'openai_responses',
        payload: {
          model: 'gpt-5.4',
          input: ['hello', 'from array']
        }
      }
    }));

    expect(result).toEqual(expect.objectContaining({
      requestMessageCount: 2,
      responseMessageCount: 0
    }) satisfies Partial<RequestArchiveServiceResult>);
    expect(state.attemptMessages.filter((record) => record.side === 'request')).toHaveLength(2);
    expect(state.messageBlobs.map((record) => record.normalizedPayload)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'from array' }]
      }
    ]);
  });

  it('skips raw_request archiving by default (opt-in via ARCHIVE_RAW_REQUEST_ENABLED)', async () => {
    const prev = process.env.ARCHIVE_RAW_REQUEST_ENABLED;
    delete process.env.ARCHIVE_RAW_REQUEST_ENABLED;
    try {
      const { service, state } = createService();
      const rawRequest = JSON.stringify({ kind: 'request', body: 'x'.repeat(512) });
      const rawResponse = JSON.stringify({ kind: 'response', body: 'y'.repeat(512) });
      const rawStream = [
        'data: {"type":"response.output_text.delta","delta":"working"}',
        '',
        'data: [DONE]',
        ''
      ].join('\n');

      await service.archiveAttempt(baseAttempt({ rawRequest, rawResponse, rawStream }));

      const kinds = state.rawBlobs.map((record) => record.blobKind).sort();
      expect(kinds).toEqual(['raw_response', 'raw_stream']);
      expect(state.attemptRawBlobs.map((record) => record.blobRole).sort()).toEqual(['response', 'stream']);

      const byKind = Object.fromEntries(state.rawBlobs.map((record) => [record.blobKind, record]));
      expect(byKind.raw_request).toBeUndefined();
      expect(byKind.raw_response.encoding).toBe('gzip');
      expect(byKind.raw_stream.encoding).toBe('gzip');
    } finally {
      if (prev === undefined) {
        delete process.env.ARCHIVE_RAW_REQUEST_ENABLED;
      } else {
        process.env.ARCHIVE_RAW_REQUEST_ENABLED = prev;
      }
    }
  });

  it('gzip-compresses raw request, response, and stream payloads when ARCHIVE_RAW_REQUEST_ENABLED=true', async () => {
    const prev = process.env.ARCHIVE_RAW_REQUEST_ENABLED;
    process.env.ARCHIVE_RAW_REQUEST_ENABLED = 'true';
    try {
      const { service, state } = createService();
      const rawRequest = JSON.stringify({ kind: 'request', body: 'x'.repeat(512) });
      const rawResponse = JSON.stringify({ kind: 'response', body: 'y'.repeat(512) });
      const rawStream = [
        'data: {"type":"response.output_text.delta","delta":"working"}',
        '',
        'data: [DONE]',
        ''
      ].join('\n');

      await service.archiveAttempt(baseAttempt({
        rawRequest,
        rawResponse,
        rawStream
      }));

      expect(state.rawBlobs).toHaveLength(3);
      expect(state.attemptRawBlobs).toEqual([
        { requestAttemptArchiveId: 'archive_1', blobRole: 'request', rawBlobId: 'raw_1' },
        { requestAttemptArchiveId: 'archive_1', blobRole: 'response', rawBlobId: 'raw_2' },
        { requestAttemptArchiveId: 'archive_1', blobRole: 'stream', rawBlobId: 'raw_3' }
      ]);

      const byKind = Object.fromEntries(state.rawBlobs.map((record) => [record.blobKind, record]));

      expect(byKind.raw_request).toEqual(expect.objectContaining({
        encoding: 'gzip',
        bytesCompressed: byKind.raw_request.payload.length,
        bytesUncompressed: Buffer.byteLength(rawRequest)
      }));
      expect(byKind.raw_response).toEqual(expect.objectContaining({
        encoding: 'gzip',
        bytesCompressed: byKind.raw_response.payload.length,
        bytesUncompressed: Buffer.byteLength(rawResponse)
      }));
      expect(byKind.raw_stream).toEqual(expect.objectContaining({
        encoding: 'gzip',
        bytesCompressed: byKind.raw_stream.payload.length,
        bytesUncompressed: Buffer.byteLength(rawStream)
      }));

      expect(byKind.raw_request.bytesCompressed).toBeLessThan(byKind.raw_request.bytesUncompressed);
      expect(byKind.raw_response.bytesCompressed).toBeLessThan(byKind.raw_response.bytesUncompressed);
      expect(decodeBuffer(byKind.raw_request.payload)).toBe(rawRequest);
      expect(decodeBuffer(byKind.raw_response.payload)).toBe(rawResponse);
      expect(decodeBuffer(byKind.raw_stream.payload)).toBe(rawStream);
    } finally {
      if (prev === undefined) {
        delete process.env.ARCHIVE_RAW_REQUEST_ENABLED;
      } else {
        process.env.ARCHIVE_RAW_REQUEST_ENABLED = prev;
      }
    }
  });

  it('rolls back the archive transaction without orphaned rows when a raw blob write fails', async () => {
    const { service, state } = createService({ failOnRawBlobKind: 'raw_response' });

    await expect(service.archiveAttempt(baseAttempt())).rejects.toThrow('forced raw blob failure: raw_response');

    expect(state.attempts).toHaveLength(0);
    expect(state.messageBlobs).toHaveLength(0);
    expect(state.attemptMessages).toHaveLength(0);
    expect(state.rawBlobs).toHaveLength(0);
    expect(state.attemptRawBlobs).toHaveLength(0);
  });

  it('stores final normalized streaming output alongside a separate raw stream blob', async () => {
    const { service, state } = createService();
    const rawStream = [
      'data: {"type":"response.output_text.delta","delta":"working"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_stream_1","status":"completed"}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    await service.archiveAttempt(baseAttempt({
      provider: 'openai',
      model: 'gpt-5.4',
      streaming: true,
      request: {
        format: 'openai_responses',
        payload: {
          model: 'gpt-5.4',
          instructions: 'be concise',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          stream: true
        }
      },
      response: {
        format: 'openai_responses',
        payload: {
          id: 'resp_stream_1',
          status: 'completed',
          output: [{
            type: 'message',
            id: 'msg_stream_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'working' }]
          }]
        }
      },
      rawResponse: null,
      rawStream
    }));

    expect(state.attemptMessages.filter((record) => record.side === 'response')).toHaveLength(1);
    // raw_request is opt-in (ARCHIVE_RAW_REQUEST_ENABLED); rawResponse is null here.
    expect(state.rawBlobs).toHaveLength(1);
    expect(state.attemptRawBlobs.map((record) => record.blobRole).sort()).toEqual(['stream']);
    expect(state.messageBlobs.find((record) => record.role === 'assistant')?.normalizedPayload).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }]
    });
    const streamBlob = state.rawBlobs.find((record) => record.blobKind === 'raw_stream');
    expect(streamBlob).toBeDefined();
    expect(decodeBuffer(streamBlob!.payload)).toBe(rawStream);
  });
});
