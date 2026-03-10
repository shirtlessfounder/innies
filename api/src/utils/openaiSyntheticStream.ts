function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function normalizeUsage(response: Record<string, unknown>): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const usage = isRecord(response.usage) ? response.usage : {};
  const input_tokens = Number(usage.input_tokens ?? 0);
  const output_tokens = Number(usage.output_tokens ?? 0);
  return {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens
  };
}

function normalizeArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalizeMessageContent(item: Record<string, unknown>): Array<Record<string, unknown>> {
  return asArray(item.content)
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        return { type: 'output_text', text: part.text };
      }
      return part;
    });
}

function normalizeOutputItems(response: Record<string, unknown>): Array<Record<string, unknown>> {
  const output = asArray(response.output)
    .filter((item): item is Record<string, unknown> => isRecord(item));
  if (output.length > 0) return output;

  const fallbackText = typeof response.output_text === 'string' ? response.output_text : '';
  if (fallbackText.trim().length === 0) return [];

  return [{
    type: 'message',
    id: `msg_${asString(response.id, String(Date.now()))}`,
    role: 'assistant',
    content: [{ type: 'output_text', text: fallbackText }],
    status: 'completed'
  }];
}

function sseData(payload: Record<string, unknown> | string): string {
  if (typeof payload === 'string') {
    return `data: ${payload}\n\n`;
  }
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function summarizeSyntheticOpenAiOutputItems(data: unknown): { count: number; types: string } {
  const response = isRecord(data) ? data : {};
  const output = normalizeOutputItems(response);
  const uniqueTypes = new Set<string>();
  for (const item of output) {
    uniqueTypes.add(typeof item.type === 'string' ? item.type : 'unknown');
  }
  return {
    count: output.length,
    types: Array.from(uniqueTypes).join(',')
  };
}

export function hasTerminalOpenAiResponsesStreamEvent(raw: string): boolean {
  const normalized = raw.toLowerCase();
  return (
    normalized.includes('"type":"response.completed"')
    || normalized.includes('"type":"response.failed"')
    || normalized.includes('"type":"response.incomplete"')
    || normalized.includes('data: [done]')
  );
}

export function buildSyntheticOpenAiStreamFailureSse(input: {
  id?: string;
  model?: string;
  message: string;
  code?: string;
}): string {
  const id = typeof input.id === 'string' && input.id.trim().length > 0
    ? input.id
    : `resp_${Date.now()}`;
  const response: Record<string, unknown> = {
    id,
    status: 'failed',
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    error: {
      code: input.code ?? 'stream_disconnected',
      message: input.message
    }
  };
  if (typeof input.model === 'string' && input.model.trim().length > 0) {
    response.model = input.model;
  }

  return [
    sseData({
      type: 'response.failed',
      response
    }),
    sseData('[DONE]')
  ].join('');
}

export function buildSyntheticOpenAiResponsesSse(data: unknown): string {
  const response = isRecord(data) ? data : {};
  const id = asString(response.id, `resp_${Date.now()}`);
  const model = typeof response.model === 'string' ? response.model : undefined;
  const output = normalizeOutputItems(response);
  const usage = normalizeUsage(response);
  const terminalStatus = typeof response.status === 'string' ? response.status : 'completed';
  const events: string[] = [];

  events.push(sseData({
    type: 'response.created',
    response: {
      ...(model ? { model } : {}),
      id,
      status: 'in_progress',
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  }));

  output.forEach((item, outputIndex) => {
    const itemType = typeof item.type === 'string' ? item.type : 'unknown';

    if (itemType === 'message') {
      const itemId = asString(item.id, `msg_${outputIndex}`);
      const role = asString(item.role, 'assistant');
      const content = normalizeMessageContent(item);

      events.push(sseData({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          type: 'message',
          id: itemId,
          role,
          content: [],
          status: 'in_progress'
        }
      }));

      content.forEach((part, contentIndex) => {
        if (part.type !== 'output_text') return;
        const text = asString(part.text, '');
        events.push(sseData({
          type: 'response.content_part.added',
          output_index: outputIndex,
          item_id: itemId,
          content_index: contentIndex,
          part: { type: 'output_text', text: '' }
        }));
        if (text.length > 0) {
          events.push(sseData({
            type: 'response.output_text.delta',
            output_index: outputIndex,
            item_id: itemId,
            content_index: contentIndex,
            delta: text
          }));
        }
        events.push(sseData({
          type: 'response.output_text.done',
          output_index: outputIndex,
          item_id: itemId,
          content_index: contentIndex,
          text
        }));
        events.push(sseData({
          type: 'response.content_part.done',
          output_index: outputIndex,
          item_id: itemId,
          content_index: contentIndex,
          part: { type: 'output_text', text }
        }));
      });

      events.push(sseData({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          type: 'message',
          id: itemId,
          role,
          content,
          status: typeof item.status === 'string' ? item.status : 'completed'
        }
      }));
      return;
    }

    if (itemType === 'function_call') {
      const itemId = asString(item.id, `fc_${outputIndex}`);
      const name = asString(item.name, 'tool');
      const argumentsText = normalizeArguments(item.arguments);
      const addedItem: Record<string, unknown> = {
        type: 'function_call',
        id: itemId,
        name,
        arguments: ''
      };
      if (typeof item.call_id === 'string' && item.call_id.trim().length > 0) {
        addedItem.call_id = item.call_id;
      }
      events.push(sseData({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: addedItem
      }));
      if (argumentsText.length > 0) {
        events.push(sseData({
          type: 'response.function_call_arguments.delta',
          output_index: outputIndex,
          item_id: itemId,
          delta: argumentsText
        }));
      }
      events.push(sseData({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          ...addedItem,
          arguments: argumentsText,
          status: typeof item.status === 'string' ? item.status : 'completed'
        }
      }));
      return;
    }

    events.push(sseData({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        ...item,
        status: 'in_progress'
      }
    }));
    events.push(sseData({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        ...item,
        status: typeof item.status === 'string' ? item.status : 'completed'
      }
    }));
  });

  events.push(sseData({
    type: terminalStatus === 'failed' ? 'response.failed' : 'response.completed',
    response: {
      ...(model ? { model } : {}),
      ...response,
      id,
      output,
      status: terminalStatus,
      usage
    }
  }));
  events.push(sseData('[DONE]'));

  return events.join('');
}
