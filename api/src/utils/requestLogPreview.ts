import { truncatePreview } from './analytics.js';
import { stableJson } from './hash.js';

const MAX_DEPTH = 5;

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function appendText(parts: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length > 0) parts.push(trimmed);
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH || value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item, depth + 1));
  }

  const record = readRecord(value);
  if (!record) return [];

  const parts: string[] = [];
  appendText(parts, record.text);
  appendText(parts, record.output_text);
  appendText(parts, record.input_text);
  appendText(parts, record.content);
  appendText(parts, record.delta);
  appendText(parts, record.summary);
  appendText(parts, record.message);

  for (const key of ['content', 'messages', 'input', 'output', 'parts', 'message', 'response', 'item', 'choices', 'error']) {
    parts.push(...collectText(record[key], depth + 1));
  }

  return parts;
}

function joinPreviewParts(parts: string[]): string | null {
  const joined = parts.join('\n').trim();
  return truncatePreview(joined);
}

function extractAnthropicRequestPreview(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  parts.push(...collectText(payload.system));

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const rawMessage of messages) {
    const message = readRecord(rawMessage);
    if (!message) continue;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role === 'assistant') continue;
    parts.push(...collectText(message.content));
  }

  return joinPreviewParts(parts);
}

function extractResponsesRequestPreview(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  parts.push(...collectText(payload.instructions));
  parts.push(...collectText(payload.input));
  return joinPreviewParts(parts);
}

function extractSsePreview(raw: string): string | null {
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      parts.push(...collectText(JSON.parse(payload)));
    } catch {
      appendText(parts, payload);
    }
  }

  return joinPreviewParts(parts) ?? truncatePreview(raw);
}

export function serializeRequestLogBody(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return stableJson(value);
  } catch {
    return String(value);
  }
}

export function extractRequestPreview(payload: unknown, proxiedPath: string): string | null {
  const record = readRecord(payload);
  if (record) {
    if (proxiedPath.startsWith('/v1/messages')) {
      return extractAnthropicRequestPreview(record) ?? truncatePreview(serializeRequestLogBody(record));
    }

    if (proxiedPath.startsWith('/v1/responses')) {
      return extractResponsesRequestPreview(record) ?? truncatePreview(serializeRequestLogBody(record));
    }

    return joinPreviewParts(collectText(record)) ?? truncatePreview(serializeRequestLogBody(record));
  }

  return truncatePreview(typeof payload === 'string' ? payload : serializeRequestLogBody(payload));
}

export function extractResponsePreview(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.includes('data:') ? extractSsePreview(payload) : truncatePreview(payload);
  }

  const record = readRecord(payload);
  if (record) {
    return joinPreviewParts(collectText(record)) ?? truncatePreview(serializeRequestLogBody(record));
  }

  return truncatePreview(serializeRequestLogBody(payload));
}
