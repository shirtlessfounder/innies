import { MessageBlobRepository } from '../../repos/messageBlobRepository.js';
import { RawBlobRepository } from '../../repos/rawBlobRepository.js';
import { AdminAnalysisProjectionOutboxRepository } from '../../repos/adminAnalysisProjectionOutboxRepository.js';
import { AdminSessionProjectionOutboxRepository } from '../../repos/adminSessionProjectionOutboxRepository.js';
import { RequestAttemptArchiveRepository } from '../../repos/requestAttemptArchiveRepository.js';
import { RequestAttemptMessageRepository } from '../../repos/requestAttemptMessageRepository.js';
import { RequestAttemptRawBlobRepository } from '../../repos/requestAttemptRawBlobRepository.js';
import type { TransactionContext } from '../../repos/sqlClient.js';
import { encodeArchiveRawBlob } from './archiveCodec.js';
import { hashNormalizedPayload, hashRawBytes } from './archiveHash.js';
import { normalizeArchiveMessages } from './archiveNormalizer.js';
import {
  ARCHIVE_NORMALIZED_PAYLOAD_CODEC_VERSION,
  type ArchiveAttemptInput,
  type ArchivePreparedRawBlob,
  type NormalizedArchiveMessageEntry,
  type RequestArchiveServiceDeps,
  type RequestArchiveServiceRepoFactory,
  type RequestArchiveServiceResult
} from './archiveTypes.js';

const defaultRepoFactory: RequestArchiveServiceRepoFactory = {
  requestAttemptArchives(tx: TransactionContext) {
    return new RequestAttemptArchiveRepository(tx as never);
  },
  messageBlobs(tx: TransactionContext) {
    return new MessageBlobRepository(tx as never);
  },
  requestAttemptMessages(tx: TransactionContext) {
    return new RequestAttemptMessageRepository(tx as never);
  },
  rawBlobs(tx: TransactionContext) {
    return new RawBlobRepository(tx as never);
  },
  requestAttemptRawBlobs(tx: TransactionContext) {
    return new RequestAttemptRawBlobRepository(tx as never);
  },
  sessionProjectionOutbox(tx: TransactionContext) {
    return new AdminSessionProjectionOutboxRepository(tx as never);
  },
  analysisProjectionOutbox(tx: TransactionContext) {
    return new AdminAnalysisProjectionOutboxRepository(tx as never);
  }
};

export class RequestArchiveService {
  private readonly repoFactory: RequestArchiveServiceRepoFactory;

  constructor(private readonly deps: RequestArchiveServiceDeps) {
    this.repoFactory = deps.repoFactory ?? defaultRepoFactory;
  }

  async archiveAttempt(input: ArchiveAttemptInput): Promise<RequestArchiveServiceResult> {
    const normalizedRequest = normalizeArchiveMessages(input.request, 'request');
    const normalizedResponse = normalizeArchiveMessages(input.response ?? null, 'response');
    const rawBlobs = prepareRawBlobs(input);

    return this.deps.sql.transaction(async (tx) => {
      const repos = {
        requestAttemptArchives: this.repoFactory.requestAttemptArchives(tx),
        messageBlobs: this.repoFactory.messageBlobs(tx),
        requestAttemptMessages: this.repoFactory.requestAttemptMessages(tx),
        rawBlobs: this.repoFactory.rawBlobs(tx),
        requestAttemptRawBlobs: this.repoFactory.requestAttemptRawBlobs(tx),
        sessionProjectionOutbox: this.repoFactory.sessionProjectionOutbox(tx),
        analysisProjectionOutbox: this.repoFactory.analysisProjectionOutbox(tx)
      };

      const archive = await repos.requestAttemptArchives.upsertArchive({
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
      });

      await repos.sessionProjectionOutbox.enqueueAttempt({
        requestAttemptArchiveId: archive.id,
        requestId: archive.request_id,
        attemptNo: archive.attempt_no,
        orgId: archive.org_id,
        apiKeyId: archive.api_key_id
      });
      await repos.analysisProjectionOutbox.enqueueAttempt({
        requestAttemptArchiveId: archive.id,
        requestId: archive.request_id,
        attemptNo: archive.attempt_no,
        orgId: archive.org_id,
        apiKeyId: archive.api_key_id
      });

      await this.persistMessages(archive.id, 'request', normalizedRequest, repos);
      await this.persistMessages(archive.id, 'response', normalizedResponse, repos);

      for (const rawBlob of rawBlobs) {
        const rawBlobRow = await repos.rawBlobs.upsertBlob({
          contentHash: rawBlob.contentHash,
          blobKind: rawBlob.blobKind,
          encoding: rawBlob.encoded.encoding,
          bytesCompressed: rawBlob.encoded.bytesCompressed,
          bytesUncompressed: rawBlob.encoded.bytesUncompressed,
          payload: rawBlob.encoded.payload
        });
        await repos.requestAttemptRawBlobs.upsertLink({
          requestAttemptArchiveId: archive.id,
          blobRole: rawBlob.blobRole,
          rawBlobId: rawBlobRow.id
        });
      }

      return {
        archiveId: archive.id,
        requestMessageCount: normalizedRequest.length,
        responseMessageCount: normalizedResponse.length,
        rawBlobRoles: rawBlobs.map((rawBlob) => rawBlob.blobRole)
      };
    });
  }

  private async persistMessages(
    archiveId: string,
    side: 'request' | 'response',
    messages: NormalizedArchiveMessageEntry[],
    repos: {
      messageBlobs: ReturnType<RequestArchiveServiceRepoFactory['messageBlobs']>;
      requestAttemptMessages: ReturnType<RequestArchiveServiceRepoFactory['requestAttemptMessages']>;
    }
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const links = [];
    for (const [ordinal, message] of messages.entries()) {
      const messageBlob = await repos.messageBlobs.upsertBlob({
        contentHash: hashNormalizedPayload(message.normalizedPayload),
        kind: message.kind,
        role: message.role,
        contentType: message.contentType,
        normalizedPayload: message.normalizedPayload,
        normalizedPayloadCodecVersion: ARCHIVE_NORMALIZED_PAYLOAD_CODEC_VERSION
      });
      links.push({
        requestAttemptArchiveId: archiveId,
        side,
        ordinal,
        messageBlobId: messageBlob.id,
        role: message.role,
        contentType: message.contentType
      });
    }

    await repos.requestAttemptMessages.upsertLinks(links);
  }
}

function isRawRequestArchivingEnabled(): boolean {
  // Opt-in: raw_request is the cumulative conversation on multi-turn agent
  // traffic and blows up storage (no cross-turn dedup). The structured
  // request content is already captured per-message in in_message_blobs
  // with content-hash dedup, so keep raw_request off by default.
  return process.env.ARCHIVE_RAW_REQUEST_ENABLED === 'true';
}

function prepareRawBlobs(input: ArchiveAttemptInput): ArchivePreparedRawBlob[] {
  const rawBlobs: ArchivePreparedRawBlob[] = [];

  if (isRawRequestArchivingEnabled() && input.rawRequest != null) {
    const encoded = encodeArchiveRawBlob(input.rawRequest);
    rawBlobs.push({
      blobRole: 'request',
      blobKind: 'raw_request',
      contentHash: hashRawBytes(encoded.rawBuffer),
      encoded
    });
  }

  if (input.rawResponse != null) {
    const encoded = encodeArchiveRawBlob(input.rawResponse);
    rawBlobs.push({
      blobRole: 'response',
      blobKind: 'raw_response',
      contentHash: hashRawBytes(encoded.rawBuffer),
      encoded
    });
  }

  if (input.rawStream != null) {
    const encoded = encodeArchiveRawBlob(input.rawStream);
    rawBlobs.push({
      blobRole: 'stream',
      blobKind: 'raw_stream',
      contentHash: hashRawBytes(encoded.rawBuffer),
      encoded
    });
  }

  return rawBlobs;
}
