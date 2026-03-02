import { IdempotencyRepository, type IdempotencyRecord } from '../repos/idempotencyRepository.js';
import { AppError } from '../utils/errors.js';

export type IdempotencyStart = {
  scope: string;
  tenantScope: string;
  idempotencyKey: string;
  requestHash: string;
};

export type IdempotencyReplay = {
  replay: true;
  responseCode: number;
  responseBody: Record<string, unknown> | null;
};

export type IdempotencySession = {
  replay: false;
  input: IdempotencyStart;
  existing?: IdempotencyRecord;
};

export class IdempotencyService {
  constructor(private readonly repo: IdempotencyRepository) {}

  async start(input: IdempotencyStart): Promise<IdempotencyReplay | IdempotencySession> {
    const existing = await this.repo.find(input.scope, input.tenantScope, input.idempotencyKey);
    if (!existing) {
      return { replay: false, input };
    }

    if (existing.request_hash !== input.requestHash) {
      throw new AppError('idempotency_mismatch', 409, 'Idempotency key re-used with different request payload');
    }

    return {
      replay: true,
      responseCode: existing.response_code,
      responseBody: existing.response_body
    };
  }

  async commit(session: IdempotencySession, output: {
    responseCode: number;
    responseBody: Record<string, unknown> | null;
    responseDigest?: string | null;
    responseRef?: string | null;
  }): Promise<void> {
    if (session.replay) return;

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    try {
      await this.repo.store({
        scope: session.input.scope,
        tenantScope: session.input.tenantScope,
        idempotencyKey: session.input.idempotencyKey,
        requestHash: session.input.requestHash,
        responseCode: output.responseCode,
        responseBody: output.responseBody,
        responseDigest: output.responseDigest,
        responseRef: output.responseRef,
        expiresAt
      });
    } catch (error: unknown) {
      // A concurrent request may have inserted first. We can safely ignore if that happened.
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '23505';
}
