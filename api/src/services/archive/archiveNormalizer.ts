import type {
  ArchivePayloadSource,
  ArchivePersistSide,
  NormalizedArchiveContentPart,
  NormalizedArchiveMessageEntry,
  NormalizedArchiveRole
} from './archiveTypes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRole(value: unknown): NormalizedArchiveRole | null {
  if (value !== 'system' && value !== 'user' && value !== 'assistant') {
    return null;
  }

  return value;
}

function normalizeTextPart(value: unknown): NormalizedArchiveContentPart[] {
  if (typeof value !== 'string') {
    return [];
  }

  return [{ type: 'text', text: value }];
}

function tryParseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeContentType(parts: NormalizedArchiveContentPart[]): string {
  const uniqueTypes = Array.from(new Set(parts.map((part) => part.type)));
  return uniqueTypes.length === 1 ? uniqueTypes[0] : 'mixed';
}

function buildMessage(
  role: NormalizedArchiveRole,
  parts: NormalizedArchiveContentPart[]
): NormalizedArchiveMessageEntry[] {
  if (parts.length === 0) {
    return [];
  }

  return [{
    kind: 'message',
    role,
    contentType: summarizeContentType(parts),
    normalizedPayload: {
      role,
      content: parts
    }
  }];
}

function normalizeAnthropicBlock(value: unknown): NormalizedArchiveContentPart[] {
  if (typeof value === 'string') {
    return normalizeTextPart(value);
  }

  if (!isRecord(value)) {
    return value == null ? [] : [{ type: 'json', value }];
  }

  switch (value.type) {
    case 'text':
      return normalizeTextPart(value.text);
    case 'tool_use':
      return [{
        type: 'tool_call',
        id: typeof value.id === 'string' ? value.id : null,
        name: typeof value.name === 'string' ? value.name : null,
        arguments: value.input ?? {}
      }];
    case 'tool_result':
      return [{
        type: 'tool_result',
        toolUseId: typeof value.tool_use_id === 'string' ? value.tool_use_id : null,
        content: value.content ?? null
      }];
    default:
      return [{ type: 'json', value }];
  }
}

function normalizeAnthropicContent(value: unknown): NormalizedArchiveContentPart[] {
  if (typeof value === 'string') {
    return normalizeTextPart(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((part) => normalizeAnthropicBlock(part));
  }

  if (value == null) {
    return [];
  }

  return normalizeAnthropicBlock(value);
}

function normalizeAnthropicSystem(value: unknown): NormalizedArchiveMessageEntry[] {
  if (typeof value === 'string') {
    return buildMessage('system', normalizeTextPart(value));
  }

  if (Array.isArray(value)) {
    return buildMessage('system', value.flatMap((part) => normalizeAnthropicBlock(part)));
  }

  if (value == null) {
    return [];
  }

  return buildMessage('system', [{ type: 'json', value }]);
}

function normalizeAnthropicMessage(value: unknown): NormalizedArchiveMessageEntry[] {
  if (!isRecord(value)) {
    return [];
  }

  const role = normalizeRole(value.role);
  if (!role) {
    return [];
  }

  return buildMessage(role, normalizeAnthropicContent(value.content));
}

function normalizeAnthropicPayload(
  payload: unknown,
  side: ArchivePersistSide
): NormalizedArchiveMessageEntry[] {
  if (!isRecord(payload)) {
    return [];
  }

  const messages: NormalizedArchiveMessageEntry[] = [];

  if (side === 'request') {
    messages.push(...normalizeAnthropicSystem(payload.system));
  }

  if (Array.isArray(payload.messages)) {
    return messages.concat(payload.messages.flatMap((message) => normalizeAnthropicMessage(message)));
  }

  if (typeof payload.role === 'string' && Object.prototype.hasOwnProperty.call(payload, 'content')) {
    return messages.concat(normalizeAnthropicMessage(payload));
  }

  return messages;
}

function normalizeOpenAiMessageContent(value: unknown): NormalizedArchiveContentPart[] {
  if (typeof value === 'string') {
    return normalizeTextPart(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((part) => {
      if (typeof part === 'string') {
        return normalizeTextPart(part);
      }

      if (!isRecord(part)) {
        return part == null ? [] : [{ type: 'json', value: part }];
      }

      if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        return [{ type: 'text', text: part.text }];
      }

      return [{ type: 'json', value: part }];
    });
  }

  if (value == null) {
    return [];
  }

  return [{ type: 'json', value }];
}

function normalizeOpenAiMessageItem(value: Record<string, unknown>): NormalizedArchiveMessageEntry[] {
  const role = normalizeRole(value.role);
  if (!role) {
    return [];
  }

  return buildMessage(role, normalizeOpenAiMessageContent(value.content));
}

function normalizeOpenAiFunctionCall(value: Record<string, unknown>): NormalizedArchiveMessageEntry[] {
  return buildMessage('assistant', [{
    type: 'tool_call',
    id: typeof value.call_id === 'string' ? value.call_id : null,
    name: typeof value.name === 'string' ? value.name : null,
    arguments: tryParseJsonString(value.arguments ?? {})
  }]);
}

function normalizeOpenAiFunctionCallOutput(value: Record<string, unknown>): NormalizedArchiveMessageEntry[] {
  return buildMessage('user', [{
    type: 'tool_result',
    toolUseId: typeof value.call_id === 'string' ? value.call_id : null,
    content: value.output ?? null
  }]);
}

function normalizeOpenAiItem(
  value: unknown,
  side: ArchivePersistSide
): NormalizedArchiveMessageEntry[] {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return [];
  }

  switch (value.type) {
    case 'message':
      return normalizeOpenAiMessageItem(value);
    case 'function_call':
      return normalizeOpenAiFunctionCall(value);
    case 'function_call_output':
      return normalizeOpenAiFunctionCallOutput(value);
    default:
      return buildMessage(side === 'response' ? 'assistant' : 'user', [{ type: 'json', value }]);
  }
}

function normalizeOpenAiRequestInput(value: unknown): NormalizedArchiveMessageEntry[] {
  if (typeof value === 'string') {
    return buildMessage('user', [{ type: 'text', text: value }]);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') {
        return buildMessage('user', [{ type: 'text', text: item }]);
      }

      return normalizeOpenAiItem(item, 'request');
    });
  }

  return [];
}

function extractOpenAiFallbackText(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.output_text,
    payload.detail,
    payload.message,
    isRecord(payload.error) ? payload.error.message : null
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return null;
}

function normalizeOpenAiPayload(
  payload: unknown,
  side: ArchivePersistSide
): NormalizedArchiveMessageEntry[] {
  if (!isRecord(payload)) {
    return [];
  }

  const messages: NormalizedArchiveMessageEntry[] = [];

  if (side === 'request' && typeof payload.instructions === 'string') {
    messages.push(...buildMessage('system', [{ type: 'text', text: payload.instructions }]));
  }

  if (side === 'request') {
    const requestMessages = normalizeOpenAiRequestInput(payload.input);
    if (requestMessages.length > 0) {
      return messages.concat(requestMessages);
    }
  }

  const items = asArray(payload.output);
  if (items.length > 0) {
    return messages.concat(items.flatMap((item) => normalizeOpenAiItem(item, side)));
  }

  if (side === 'response') {
    const fallbackText = extractOpenAiFallbackText(payload);
    if (fallbackText !== null) {
      return messages.concat(buildMessage('assistant', [{ type: 'text', text: fallbackText }]));
    }
  }

  return messages;
}

export function normalizeArchiveMessages(
  source: ArchivePayloadSource | null | undefined,
  side: ArchivePersistSide
): NormalizedArchiveMessageEntry[] {
  if (!source) {
    return [];
  }

  switch (source.format) {
    case 'anthropic_messages':
      return normalizeAnthropicPayload(source.payload, side);
    case 'openai_responses':
      return normalizeOpenAiPayload(source.payload, side);
    default:
      return [];
  }
}
