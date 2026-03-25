function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.code === 'string' && record.code.trim().length > 0) {
      return record.code;
    }
    if (typeof record.kind === 'string' && record.kind.trim().length > 0) {
      return record.kind;
    }
  }
  return fallback;
}

export function getInviteAcceptanceErrorMessage(body: unknown, fallback: string): string {
  const message = readErrorMessage(body, fallback);
  return message === 'invite_no_longer_valid'
    ? 'This invite is no longer valid.'
    : message;
}
