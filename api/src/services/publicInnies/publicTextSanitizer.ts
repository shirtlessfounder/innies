const REDACTED_CREDENTIAL = '[REDACTED_CREDENTIAL]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';
const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const REDACTED_PATH = '[REDACTED_PATH]';

const TOOL_PAYLOAD_MAX_CHARS = 4_000;

const AUTH_HEADER_KEY =
  '(?:authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|access-token|refresh-token|id-token|session-token)';

const AUTH_HEADER_QUOTED_PATTERN = new RegExp(
  `((?:^|[\\s,{])"?${AUTH_HEADER_KEY}"?\\s*[:=]\\s*")([^"\\r\\n]*)(")`,
  'gim'
);

const AUTH_HEADER_PATTERN = new RegExp(
  `((?:^|[\\s,{])"?${AUTH_HEADER_KEY}"?\\s*[:=]\\s*)(?:(?:bearer|basic)\\s+[^\\s,;)}\\]]+|[^"\\s,;)}\\]]+)`,
  'gim'
);

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UNIX_PATH_PATTERN = /(^|[\s("'=])(~\/[^\s"'`,;)\]}]+|\/(?:Users|home|tmp|private|var\/folders|Volumes)\/[^\s"'`,;)\]}]+)/g;
const WINDOWS_PATH_PATTERN = /(^|[\s("'=])([A-Za-z]:\\(?:Users|Documents and Settings|Temp|Windows|Program Files(?: \(x86\))?)[^ \t\r\n"'`,;)\]}]*)/g;
const JWT_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g;
const PREFIXED_TOKEN_PATTERN = /\b(?:sk(?:-proj)?|rk|pk|pat|tok|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi;
// Coding-assistant CLIs (Claude Code, OpenAI codex, etc) wrap user/developer
// turns in scaffolding tags: project instructions, environment context,
// memory reminders, permission specs, slash-command metadata. They're
// protocol noise, not part of the human conversation, and dominate the
// byte count on the watch-me-work panel when shown verbatim.
//
// Two shapes exist:
//   1. Balanced <tag>...</tag>  — Claude Code + most codex blocks.
//      The opening may carry attributes (`<permissions instructions>`,
//      `<EXTERNAL_UNTRUSTED_CONTENT id="...">`) so we tolerate `[^>]*`
//      after the tag name and rely on a backreference to pair the closer.
//   2. Codex's untrusted-content envelope uses an asymmetric closer
//      (`<<<END_EXTERNAL_UNTRUSTED_CONTENT id="...">>>`) — handled separately.
const SCAFFOLD_TAG_NAMES = [
  // Claude Code
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'user-prompt-submit-hook',
  // OpenAI codex
  'environment_context',
  'user_instructions',
  'INSTRUCTIONS',
  'permissions',
  'personality_spec',
  'turn_aborted',
  'user-message-id'
];
const SCAFFOLD_TAG_PATTERN = new RegExp(
  `<(${SCAFFOLD_TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>\\s*`,
  'gi'
);
const EXTERNAL_UNTRUSTED_CONTENT_PATTERN =
  /<EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\s*/gi;

function capText(value: string, maxChars = TOOL_PAYLOAD_MAX_CHARS): string {
  const safeMaxChars = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : TOOL_PAYLOAD_MAX_CHARS;
  if (value.length <= safeMaxChars) {
    return value;
  }

  if (safeMaxChars <= 3) {
    return value.slice(0, safeMaxChars);
  }

  return `${value.slice(0, safeMaxChars - 3)}...`;
}

function createCircularSafeJsonReplacer(): (_key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }

    if (typeof value === 'symbol') {
      return value.toString();
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    return value;
  };
}

function stringifyUnknownPayload(input: unknown): string {
  if (input == null) {
    return '';
  }

  if (typeof input === 'string') {
    return input;
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }

  try {
    const json = JSON.stringify(input, createCircularSafeJsonReplacer());
    if (typeof json === 'string') {
      return json;
    }
  } catch {
    return '[Unserializable tool payload]';
  }

  return String(input);
}

export function sanitizePublicText(input: string): string {
  if (input.length === 0) {
    return '';
  }

  let text = input;

  // Strip the CLI-injected scaffolding first so secrets/paths nested inside
  // those blocks don't get redacted-in-place (which would leave orphan
  // "[REDACTED_TOKEN]" lines with no surrounding context), and so the byte
  // count drops before we run the rest of the regexes.
  text = text.replace(SCAFFOLD_TAG_PATTERN, '');
  text = text.replace(EXTERNAL_UNTRUSTED_CONTENT_PATTERN, '');

  text = text.replace(AUTH_HEADER_QUOTED_PATTERN, (_match, prefix: string, _value: string, suffix: string) =>
    `${prefix}${REDACTED_CREDENTIAL}${suffix}`
  );

  text = text.replace(AUTH_HEADER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_CREDENTIAL}`);
  text = text.replace(EMAIL_PATTERN, REDACTED_EMAIL);
  text = text.replace(UNIX_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`);
  text = text.replace(WINDOWS_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`);
  text = text.replace(JWT_TOKEN_PATTERN, REDACTED_TOKEN);
  text = text.replace(PREFIXED_TOKEN_PATTERN, REDACTED_TOKEN);

  return text;
}

export function stringifyPublicToolPayload(input: unknown): string {
  const stringified = stringifyUnknownPayload(input);
  if (stringified.length === 0) {
    return '';
  }

  return capText(sanitizePublicText(stringified));
}

/**
 * Walk an arbitrary JSON-shaped value and return a deep copy where every
 * string has been passed through `sanitizePublicText`. Arrays and plain
 * objects are reconstructed; non-string scalars pass through unchanged.
 *
 * Use this when you need to scrub a normalized payload (e.g. the admin
 * `/v1/admin/me/live-sessions` endpoint) that contains user/assistant
 * content before handing it to a client that might leak to the public
 * internet (e.g. innies.work rendering via a server-side proxy route).
 */
export function sanitizePublicDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') {
    return sanitizePublicText(value) as unknown as T;
  }

  if (value == null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicDeep(item, seen)) as unknown as T;
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    next[key] = sanitizePublicDeep(source[key], seen);
  }
  return next as unknown as T;
}
