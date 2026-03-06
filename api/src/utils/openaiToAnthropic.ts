type TranslateOpenAiToAnthropicInput = {
  data: unknown;
  model: string;
};

type MapOpenAiErrorResult = {
  status: number;
  body: {
    type: 'error';
    error: {
      type: string;
      message: string;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
    if (Array.isArray(parsed)) return { items: parsed };
    if (parsed == null) return {};
    return { value: parsed };
  } catch {
    return { raw: value };
  }
}

function translateMessageItemContent(item: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = asArray(item.content);
  return content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .flatMap((part) => {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        return [{ type: 'text', text: part.text }];
      }
      return [];
    });
}

function translateOutputItem(item: Record<string, unknown>): Array<Record<string, unknown>> {
  if (item.type === 'message') {
    return translateMessageItemContent(item);
  }

  if (item.type === 'function_call') {
    // Strict call_id contract: call_id is the only valid continuation key.
    // Do not fall back to item.id or generate synthetic IDs.
    const toolId = typeof item.call_id === 'string' ? item.call_id : null;
    if (!toolId) return []; // Missing call_id = translation error, skip item
    return [{
      type: 'tool_use',
      id: toolId,
      name: typeof item.name === 'string' ? item.name : 'tool',
      input: safeParseObject(typeof item.arguments === 'string' ? item.arguments : '{}')
    }];
  }

  if (item.type === 'reasoning') {
    const thinking = typeof item.content === 'string'
      ? item.content
      : typeof item.summary === 'string'
        ? item.summary
        : '';
    if (thinking.trim().length === 0) return [];
    return [{ type: 'thinking', thinking }];
  }

  return [];
}

function resolveStopReason(data: Record<string, unknown>, content: Array<Record<string, unknown>>): string | null {
  if (content.some((block) => block.type === 'tool_use')) return 'tool_use';
  if (data.status === 'incomplete') {
    const incompleteDetails = isRecord(data.incomplete_details) ? data.incomplete_details : null;
    if (incompleteDetails?.reason === 'max_output_tokens') return 'max_tokens';
  }
  if (data.status === 'completed') return 'end_turn';
  return null;
}

function extractUsage(data: Record<string, unknown>): { input_tokens: number; output_tokens: number } {
  const usage = isRecord(data.usage) ? data.usage : {};
  return {
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0)
  };
}

function resolveErrorMessage(data: unknown, fallback: string): string {
  if (isRecord(data)) {
    const nestedError = isRecord(data.error) ? data.error : null;
    if (nestedError && typeof nestedError.message === 'string' && nestedError.message.trim().length > 0) {
      return nestedError.message;
    }
    if (typeof data.message === 'string' && data.message.trim().length > 0) {
      return data.message;
    }
  }
  return fallback;
}

export function openAiOutputToAnthropicContent(output: unknown): Array<Record<string, unknown>> {
  return asArray(output)
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .flatMap((item) => translateOutputItem(item));
}

export function resolveAnthropicStopReason(data: unknown): string | null {
  const record = isRecord(data) ? data : {};
  return resolveStopReason(record, openAiOutputToAnthropicContent(record.output));
}

export function mapOpenAiErrorToAnthropic(status: number, data: unknown): MapOpenAiErrorResult {
  const normalizedStatus = status >= 500 ? 500 : status;
  const errorType = normalizedStatus === 400
    ? 'invalid_request_error'
    : normalizedStatus === 401
      ? 'authentication_error'
      : normalizedStatus === 403
        ? 'permission_error'
        : normalizedStatus === 429
          ? 'rate_limit_error'
          : 'api_error';
  const fallbackMessage = normalizedStatus === 400
    ? 'Invalid request'
    : normalizedStatus === 401
      ? 'Authentication failed'
      : normalizedStatus === 403
        ? 'Permission denied'
        : normalizedStatus === 429
          ? 'Rate limited'
          : 'Upstream provider error';

  return {
    status: normalizedStatus,
    body: {
      type: 'error',
      error: {
        type: errorType,
        message: resolveErrorMessage(data, fallbackMessage)
      }
    }
  };
}

export function translateOpenAiToAnthropic(input: TranslateOpenAiToAnthropicInput): Record<string, unknown> {
  const data = isRecord(input.data) ? input.data : {};
  const output = openAiOutputToAnthropicContent(data.output);
  const usage = extractUsage(data);

  return {
    id: typeof data.id === 'string' ? data.id : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content: output,
    stop_reason: resolveStopReason(data, output),
    stop_sequence: null,
    usage
  };
}

export function openaiToAnthropic(data: unknown, options?: { model?: string }): Record<string, unknown> {
  const record = isRecord(data) ? data : {};
  const model = typeof options?.model === 'string' && options.model.trim().length > 0
    ? options.model
    : typeof record.model === 'string' && record.model.trim().length > 0
      ? record.model
      : 'translated-openai';

  return translateOpenAiToAnthropic({
    data,
    model
  });
}
