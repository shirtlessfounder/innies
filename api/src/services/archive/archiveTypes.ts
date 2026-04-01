import type {
  RequestAttemptArchiveInput,
  RequestAttemptArchiveRow
} from '../../repos/requestAttemptArchiveRepository.js';
import type { MessageBlobInput, MessageBlobRow } from '../../repos/messageBlobRepository.js';
import type {
  RequestAttemptMessageLinkInput,
  RequestAttemptMessageRow,
  RequestAttemptMessageSide
} from '../../repos/requestAttemptMessageRepository.js';
import type {
  RawBlobEncoding,
  RawBlobInput,
  RawBlobKind,
  RawBlobRow
} from '../../repos/rawBlobRepository.js';
import type {
  RequestAttemptRawBlobLinkInput,
  RequestAttemptRawBlobRole,
  RequestAttemptRawBlobRow
} from '../../repos/requestAttemptRawBlobRepository.js';
import type { AdminAnalysisProjectionOutboxRow } from '../../repos/adminAnalysisProjectionOutboxRepository.js';
import type { AdminSessionProjectionOutboxRow } from '../../repos/adminSessionProjectionOutboxRepository.js';
import type { SqlClient, TransactionContext } from '../../repos/sqlClient.js';

export const ARCHIVE_NORMALIZED_PAYLOAD_CODEC_VERSION = 1;

export type ArchivePayloadFormat = 'anthropic_messages' | 'openai_responses';
export type ArchivePersistSide = RequestAttemptMessageSide;
export type ArchiveRawInput = unknown;

export type ArchivePayloadSource = {
  format: ArchivePayloadFormat;
  payload: unknown;
};

export type NormalizedArchiveRole = 'system' | 'user' | 'assistant';

export type NormalizedArchiveContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string | null; name: string | null; arguments: unknown }
  | { type: 'tool_result'; toolUseId: string | null; content: unknown }
  | { type: 'json'; value: unknown };

export type NormalizedArchiveMessage = {
  role: NormalizedArchiveRole;
  content: NormalizedArchiveContentPart[];
};

export type NormalizedArchiveMessageEntry = {
  kind: 'message';
  role: NormalizedArchiveRole;
  contentType: string;
  normalizedPayload: NormalizedArchiveMessage;
};

export type ArchiveEncodedRawBlob = {
  encoding: RawBlobEncoding;
  bytesCompressed: number;
  bytesUncompressed: number;
  payload: Buffer;
  rawBuffer: Buffer;
};

export type ArchivePreparedRawBlob = {
  blobRole: RequestAttemptRawBlobRole;
  blobKind: RawBlobKind;
  encoded: ArchiveEncodedRawBlob;
  contentHash: string;
};

export type ArchiveAttemptInput = RequestAttemptArchiveInput & {
  request: ArchivePayloadSource;
  response?: ArchivePayloadSource | null;
  rawRequest?: ArchiveRawInput | null;
  rawResponse?: ArchiveRawInput | null;
  rawStream?: ArchiveRawInput | null;
};

export type RequestArchiveServiceResult = {
  archiveId: string;
  requestMessageCount: number;
  responseMessageCount: number;
  rawBlobRoles: RequestAttemptRawBlobRole[];
};

export interface RequestAttemptArchiveRepositoryLike {
  upsertArchive(input: RequestAttemptArchiveInput): Promise<RequestAttemptArchiveRow>;
}

export interface MessageBlobRepositoryLike {
  upsertBlob(input: MessageBlobInput): Promise<MessageBlobRow>;
}

export interface RequestAttemptMessageRepositoryLike {
  upsertLinks(input: RequestAttemptMessageLinkInput[]): Promise<void>;
}

export interface RawBlobRepositoryLike {
  upsertBlob(input: RawBlobInput): Promise<RawBlobRow>;
}

export interface RequestAttemptRawBlobRepositoryLike {
  upsertLink(input: RequestAttemptRawBlobLinkInput): Promise<RequestAttemptRawBlobRow>;
}

export interface SessionProjectionOutboxRepositoryLike {
  enqueueAttempt(input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    orgId: string;
    apiKeyId: string | null;
  }): Promise<AdminSessionProjectionOutboxRow>;
}

export interface AnalysisProjectionOutboxRepositoryLike {
  enqueueAttempt(input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    orgId: string;
    apiKeyId: string | null;
  }): Promise<AdminAnalysisProjectionOutboxRow>;
}

export type RequestArchiveServiceRepoFactory = {
  requestAttemptArchives(tx: TransactionContext): RequestAttemptArchiveRepositoryLike;
  messageBlobs(tx: TransactionContext): MessageBlobRepositoryLike;
  requestAttemptMessages(tx: TransactionContext): RequestAttemptMessageRepositoryLike;
  rawBlobs(tx: TransactionContext): RawBlobRepositoryLike;
  requestAttemptRawBlobs(tx: TransactionContext): RequestAttemptRawBlobRepositoryLike;
  sessionProjectionOutbox(tx: TransactionContext): SessionProjectionOutboxRepositoryLike;
  analysisProjectionOutbox(tx: TransactionContext): AnalysisProjectionOutboxRepositoryLike;
};

export type RequestArchiveServiceDeps = {
  sql: Pick<SqlClient, 'transaction'>;
  repoFactory?: RequestArchiveServiceRepoFactory;
};
