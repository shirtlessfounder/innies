export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isUpstreamError(error: unknown): error is Error & { kind: string } {
  return typeof error === 'object' && error !== null && 'kind' in error;
}
