type ChatToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '';
  }
}

function joinSystemInstructions(parts: string[]): string | undefined {
  const normalized = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeChatMessageContentPart(
  value: unknown,
  role: 'user' | 'assistant'
): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: value.text
    };
  }

  const imageUrl = isRecord(value.image_url) && typeof value.image_url.url === 'string'
    ? value.image_url.url
    : (typeof value.image_url === 'string' ? value.image_url : null);
  if (value.type === 'image_url' && imageUrl && role !== 'assistant') {
    return {
      type: 'input_image',
      image_url: imageUrl
    };
  }

  return null;
}

function normalizeChatMessageContent(
  value: unknown,
  role: 'user' | 'assistant'
): string | Array<Record<string, unknown>> | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }

  if (!Array.isArray(value)) {
    return value == null ? null : stringifyJson(value);
  }

  const parts = value
    .map((part) => normalizeChatMessageContentPart(part, role))
    .filter((part): part is Record<string, unknown> => part !== null);

  if (parts.length > 0) {
    return parts;
  }

  const fallback = value
    .map((part) => (typeof part === 'string' ? part : (isRecord(part) && typeof part.text === 'string' ? part.text : '')))
    .filter((part) => part.length > 0)
    .join('\n');
  return fallback.length > 0 ? fallback : null;
}

function pushChatMessageItem(
  items: Array<Record<string, unknown>>,
  role: 'user' | 'assistant',
  content: unknown
): void {
  const normalized = normalizeChatMessageContent(content, role);
  if (normalized == null) return;
  items.push({
    type: 'message',
    role,
    content: normalized
  });
}

function translateAssistantToolCalls(value: unknown): ChatToolCall[] {
  return asArray(value)
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .flatMap((item) => {
      if (item.type !== 'function' || !isRecord(item.function) || typeof item.function.name !== 'string') {
        return [];
      }

      const id = typeof item.id === 'string' && item.id.trim().length > 0
        ? item.id
        : null;
      if (!id) return [];

      return [{
        id,
        type: 'function',
        function: {
          name: item.function.name,
          arguments: typeof item.function.arguments === 'string'
            ? item.function.arguments
            : stringifyJson(item.function.arguments ?? {})
        }
      }];
    });
}

export function normalizeOpenAiResponsesInputForCodexBackend(input: unknown): unknown {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: input }];
  }

  if (isRecord(input) && typeof input.role === 'string' && Object.prototype.hasOwnProperty.call(input, 'content') && input.type == null) {
    return [{
      type: 'message',
      role: input.role,
      content: input.content
    }];
  }

  if (!Array.isArray(input)) {
    return input;
  }

  return input.map((item) => {
    if (typeof item === 'string') {
      return { type: 'message', role: 'user', content: item };
    }
    if (isRecord(item) && typeof item.role === 'string' && Object.prototype.hasOwnProperty.call(item, 'content') && item.type == null) {
      return {
        type: 'message',
        role: item.role,
        content: item.content
      };
    }
    return item;
  });
}

export function openAiChatCompletionsToResponses(payload: unknown): Record<string, unknown> {
  const rawPayload = isRecord(payload) ? payload : {};
  const input: Array<Record<string, unknown>> = [];
  const systemInstructions: string[] = [];

  for (const rawMessage of asArray(rawPayload.messages)) {
    if (!isRecord(rawMessage) || typeof rawMessage.role !== 'string') continue;

    if (rawMessage.role === 'system') {
      const normalizedSystem = normalizeChatMessageContent(rawMessage.content, 'user');
      if (typeof normalizedSystem === 'string') {
        systemInstructions.push(normalizedSystem);
      }
      continue;
    }

    if (rawMessage.role === 'user') {
      pushChatMessageItem(input, 'user', rawMessage.content);
      continue;
    }

    if (rawMessage.role === 'assistant') {
      pushChatMessageItem(input, 'assistant', rawMessage.content);
      for (const toolCall of translateAssistantToolCalls(rawMessage.tool_calls)) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        });
      }
      continue;
    }

    if (rawMessage.role === 'tool' && typeof rawMessage.tool_call_id === 'string') {
      input.push({
        type: 'function_call_output',
        call_id: rawMessage.tool_call_id,
        output: typeof rawMessage.content === 'string'
          ? rawMessage.content
          : stringifyJson(rawMessage.content)
      });
    }
  }

  const translated: Record<string, unknown> = {
    model: rawPayload.model,
    input
  };

  const instructions = joinSystemInstructions(systemInstructions);
  if (instructions) translated.instructions = instructions;
  if (typeof rawPayload.stream === 'boolean') translated.stream = rawPayload.stream;
  if (typeof rawPayload.temperature === 'number') translated.temperature = rawPayload.temperature;
  if (typeof rawPayload.top_p === 'number') translated.top_p = rawPayload.top_p;
  if (typeof rawPayload.user === 'string' && rawPayload.user.trim().length > 0) translated.user = rawPayload.user.trim();
  if (isRecord(rawPayload.metadata)) translated.metadata = rawPayload.metadata;
  if (rawPayload.tools !== undefined) translated.tools = rawPayload.tools;
  if (rawPayload.tool_choice !== undefined) translated.tool_choice = rawPayload.tool_choice;
  if (rawPayload.stop !== undefined) translated.stop = rawPayload.stop;
  if (typeof rawPayload.max_completion_tokens === 'number') {
    translated.max_output_tokens = rawPayload.max_completion_tokens;
  } else if (typeof rawPayload.max_tokens === 'number') {
    translated.max_tokens = rawPayload.max_tokens;
  }

  return translated;
}

function extractResponsesOutputText(output: unknown): string | null {
  const parts: string[] = [];
  for (const item of asArray(output)) {
    if (!isRecord(item) || item.type !== 'message') continue;
    for (const contentPart of asArray(item.content)) {
      if (!isRecord(contentPart)) continue;
      if ((contentPart.type === 'output_text' || contentPart.type === 'text') && typeof contentPart.text === 'string') {
        parts.push(contentPart.text);
      }
    }
  }

  if (parts.length > 0) {
    return parts.join('');
  }

  return null;
}

function extractResponsesToolCalls(output: unknown): ChatToolCall[] {
  return asArray(output)
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .flatMap((item) => {
      if (item.type !== 'function_call' || typeof item.name !== 'string') {
        return [];
      }

      const id = typeof item.call_id === 'string' && item.call_id.trim().length > 0
        ? item.call_id
        : null;
      if (!id) return [];

      return [{
        id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : stringifyJson(item.arguments ?? {})
        }
      }];
    });
}

function resolveChatCompletionFinishReason(data: Record<string, unknown>, toolCalls: ChatToolCall[]): string {
  if (toolCalls.length > 0) return 'tool_calls';
  const incompleteDetails = isRecord(data.incomplete_details) ? data.incomplete_details : null;
  if (data.status === 'incomplete' && incompleteDetails?.reason === 'max_output_tokens') {
    return 'length';
  }
  return 'stop';
}

export function openAiResponsesToChatCompletions(data: unknown, model?: string): Record<string, unknown> {
  const record = isRecord(data) ? data : {};
  const toolCalls = extractResponsesToolCalls(record.output);
  const content = extractResponsesOutputText(record.output)
    ?? (typeof record.output_text === 'string' ? record.output_text : '');
  const usage = isRecord(record.usage) ? record.usage : {};
  const resolvedModel = typeof model === 'string' && model.trim().length > 0
    ? model
    : (typeof record.model === 'string' && record.model.trim().length > 0 ? record.model : 'translated-openai-chat');

  return {
    id: typeof record.id === 'string' && record.id.trim().length > 0
      ? record.id
      : `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      },
      finish_reason: resolveChatCompletionFinishReason(record, toolCalls)
    }],
    usage: {
      prompt_tokens: Number(usage.input_tokens ?? 0),
      completion_tokens: Number(usage.output_tokens ?? 0),
      total_tokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0)
    }
  };
}
