import { describe, expect, it } from 'vitest';
import {
  sanitizePublicText,
  stringifyPublicToolPayload
} from '../src/services/publicInnies/publicTextSanitizer.js';

describe('publicTextSanitizer', () => {
  it('returns an empty string for empty input', () => {
    expect(sanitizePublicText('')).toBe('');
  });

  it('redacts auth headers while preserving surrounding text', () => {
    const input = 'request failed Authorization: Bearer sk-proj-secret-token retry later';

    expect(sanitizePublicText(input)).toBe(
      'request failed Authorization: [REDACTED_CREDENTIAL] retry later'
    );
  });

  it('redacts token-like strings, emails, and machine-local paths', () => {
    const input = [
      'email ops@innies.dev',
      'token sk-proj-AbCdEfGhIjKlMnOp1234567890',
      'path /Users/dylanvu/innies/api/src/server.ts'
    ].join(' | ');

    expect(sanitizePublicText(input)).toBe(
      'email [REDACTED_EMAIL] | token [REDACTED_TOKEN] | path [REDACTED_PATH]'
    );
  });

  it('redacts jwt-like tokens embedded in surrounding text', () => {
    const input = 'debug token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo0NzMzMjYwODAwfQ.c2lnbmF0dXJlLXRleHQ now';

    expect(sanitizePublicText(input)).toBe('debug token [REDACTED_TOKEN] now');
  });

  it('stringifies unknown tool payloads safely, sanitizes them, and caps long output', () => {
    const payload = {
      authorization: 'Bearer sk-proj-secret-token',
      contact: 'ops@innies.dev',
      file: '/Users/dylanvu/innies/api/.env',
      body: 'x'.repeat(8_000)
    };

    const result = stringifyPublicToolPayload(payload);

    expect(result).toContain('"authorization":"[REDACTED_CREDENTIAL]"');
    expect(result).toContain('"contact":"[REDACTED_EMAIL]"');
    expect(result).toContain('"file":"[REDACTED_PATH]"');
    expect(result.length).toBeLessThanOrEqual(4_000);
  });

  it('strips <system-reminder> blocks injected by the Claude Code CLI', () => {
    const input = [
      'help me refactor this',
      '<system-reminder>',
      'The task tools haven\'t been used recently. You have a persistent memory at /Users/dylan/.claude/memory',
      '</system-reminder>',
      'here is the code'
    ].join('\n');

    const result = sanitizePublicText(input);
    expect(result).not.toContain('<system-reminder>');
    expect(result).not.toContain('persistent memory');
    expect(result).toContain('help me refactor this');
    expect(result).toContain('here is the code');
  });

  it('strips slash-command scaffolding tags', () => {
    const input = [
      '<command-name>/memorize</command-name>',
      '<command-args>use twitter api</command-args>',
      'actual message'
    ].join('\n');

    const result = sanitizePublicText(input);
    expect(result).not.toContain('<command-name>');
    expect(result).not.toContain('<command-args>');
    expect(result).toContain('actual message');
  });

  it('handles multiple reminder blocks in a single text', () => {
    const input = '<system-reminder>one</system-reminder>between<system-reminder>two</system-reminder>end';
    expect(sanitizePublicText(input)).toBe('betweenend');
  });

  it('handles circular tool payloads without throwing', () => {
    const payload: Record<string, unknown> = {
      name: 'tool'
    };
    payload.self = payload;

    expect(stringifyPublicToolPayload(payload)).toContain('"self":"[Circular]"');
  });
});
