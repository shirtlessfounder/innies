const COMPAT_CODEX_DEFAULT_MODEL_FALLBACK = 'gpt-5.4';

type AnthropicContentBlock = Record<string, unknown>;
type OpenAiItem = Record<string, unknown>;
type OpenAiTool = Record<string, unknown>;

type TranslateAnthropicToOpenAiInput = {
  payload: unknown;
  compatCodexDefaultModel?: string;
};

type TranslateAnthropicToOpenAiResult = {
  upstreamModel: string;
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripCacheControl(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'cache_control') continue;
    next[key] = stripCacheControl(item);
  }
  return next;
}

function joinTextParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function normalizeSystemInstructions(system: unknown): string | undefined {
  if (typeof system === 'string') {
    const trimmed = system.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(system)) {
    return undefined;
  }
  const text = joinTextParts(
    system.flatMap((block) => {
      if (!isRecord(block)) return [];
      if (typeof block.text === 'string') return [block.text];
      if (typeof block.thinking === 'string') return [block.thinking];
      return [];
    })
  );
  return text.length > 0 ? text : undefined;
}

function serializeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text));
    if (text.length > 0) return text.join('\n');
  }
  return JSON.stringify(content ?? null);
}

function normalizeImagePart(block: AnthropicContentBlock): Record<string, unknown> | null {
  const source = isRecord(block.source) ? block.source : null;
  if (!source || typeof source.type !== 'string') return null;
  if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    return {
      type: 'input_image',
      source: {
        type: 'base64',
        media_type: source.media_type,
        data: source.data
      }
    };
  }
  if ((source.type === 'url' || source.type === 'image_url') && typeof source.url === 'string') {
    return {
      type: 'input_image',
      source: {
        type: 'url',
        url: source.url
      }
    };
  }
  return null;
}

function flushMessageItem(items: OpenAiItem[], role: 'user' | 'assistant', parts: Array<string | Record<string, unknown>>): void {
  if (parts.length === 0) return;
  const allText = parts.every((part) => typeof part === 'string');
  if (allText) {
    const text = joinTextParts(parts as string[]);
    if (text.length > 0) {
      items.push({ type: 'message', role, content: text });
    }
    return;
  }

  const content = parts.map((part) => {
    if (typeof part === 'string') {
      return {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: part
      };
    }
    return part;
  });
  if (content.length > 0) {
    items.push({ type: 'message', role, content });
  }
}

function translateUserMessage(message: Record<string, unknown>, items: OpenAiItem[]): void {
  const content = message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      items.push({ type: 'message', role: 'user', content: trimmed });
    }
    return;
  }

  const pendingParts: Array<string | Record<string, unknown>> = [];
  for (const rawBlock of asArray(content)) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== 'string') continue;
    if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') {
      pendingParts.push(rawBlock.text);
      continue;
    }
    if (rawBlock.type === 'image') {
      const imagePart = normalizeImagePart(rawBlock);
      if (imagePart) pendingParts.push(imagePart);
      continue;
    }
    if (rawBlock.type === 'tool_result') {
      flushMessageItem(items, 'user', pendingParts);
      pendingParts.length = 0;
      const callId = typeof rawBlock.tool_use_id === 'string'
        ? rawBlock.tool_use_id
        : typeof rawBlock.id === 'string'
          ? rawBlock.id
          : null;
      if (!callId) continue;
      items.push({
        type: 'function_call_output',
        call_id: callId,
        output: serializeToolResultContent(rawBlock.content)
      });
    }
  }
  flushMessageItem(items, 'user', pendingParts);
}

function translateAssistantMessage(message: Record<string, unknown>, items: OpenAiItem[]): void {
  const content = message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      items.push({ type: 'message', role: 'assistant', content: trimmed });
    }
    return;
  }

  const pendingText: string[] = [];
  const flushPendingText = () => {
    if (pendingText.length === 0) return;
    flushMessageItem(items, 'assistant', [...pendingText]);
    pendingText.length = 0;
  };

  for (const rawBlock of asArray(content)) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== 'string') continue;
    if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') {
      pendingText.push(rawBlock.text);
      continue;
    }
    if (rawBlock.type === 'thinking') {
      flushPendingText();
      const thinking = typeof rawBlock.thinking === 'string'
        ? rawBlock.thinking
        : typeof rawBlock.text === 'string'
          ? rawBlock.text
          : undefined;
      if (thinking && thinking.trim().length > 0) {
        items.push({ type: 'reasoning', content: thinking.trim() });
      }
      continue;
    }
    if (rawBlock.type === 'tool_use') {
      flushPendingText();
      const callId = typeof rawBlock.id === 'string' ? rawBlock.id : undefined;
      const toolName = typeof rawBlock.name === 'string' ? rawBlock.name : 'tool';
      items.push({
        type: 'function_call',
        ...(callId ? { call_id: callId } : {}),
        name: toolName,
        arguments: JSON.stringify(rawBlock.input ?? {})
      });
    }
  }
  flushPendingText();
}

function translateMessages(messages: unknown): OpenAiItem[] {
  const items: OpenAiItem[] = [];
  for (const rawMessage of asArray(messages)) {
    if (!isRecord(rawMessage) || typeof rawMessage.role !== 'string') continue;
    if (rawMessage.role === 'user') {
      translateUserMessage(rawMessage, items);
      continue;
    }
    if (rawMessage.role === 'assistant') {
      translateAssistantMessage(rawMessage, items);
      continue;
    }
  }
  return items;
}

function translateTools(tools: unknown): OpenAiTool[] | undefined {
  const translated = asArray(tools)
    .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === 'string')
    .map((tool) => ({
      type: 'function',
      function: {
        name: String(tool.name),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(isRecord(tool.input_schema) ? { parameters: tool.input_schema } : {})
      }
    }));
  return translated.length > 0 ? translated : undefined;
}

function translateToolChoice(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice) || typeof toolChoice.type !== 'string') return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return {
      type: 'function',
      function: { name: toolChoice.name }
    };
  }
  return undefined;
}

function translateReasoning(thinking: unknown): Record<string, unknown> | undefined {
  if (!isRecord(thinking)) return undefined;
  if (thinking.type !== 'enabled') return undefined;
  return { effort: 'high' };
}

function normalizeMetadata(metadata: unknown): Record<string, string> | undefined {
  if (!isRecord(metadata)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value as string])
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function resolveCompatCodexDefaultModel(value?: string): string {
  const normalized = String(value ?? process.env.COMPAT_CODEX_DEFAULT_MODEL ?? COMPAT_CODEX_DEFAULT_MODEL_FALLBACK).trim();
  return normalized.length > 0 ? normalized : COMPAT_CODEX_DEFAULT_MODEL_FALLBACK;
}

export function translateAnthropicToOpenAi(input: TranslateAnthropicToOpenAiInput): TranslateAnthropicToOpenAiResult {
  const rawPayload = isRecord(input.payload)
    ? stripCacheControl(input.payload) as Record<string, unknown>
    : {};
  const upstreamModel = resolveCompatCodexDefaultModel(input.compatCodexDefaultModel);
  const translated: Record<string, unknown> = {
    model: upstreamModel,
    input: translateMessages(rawPayload.messages)
  };

  const instructions = normalizeSystemInstructions(rawPayload.system);
  if (instructions) translated.instructions = instructions;

  const maxOutputTokens = typeof rawPayload.max_output_tokens === 'number'
    ? rawPayload.max_output_tokens
    : typeof rawPayload.max_tokens === 'number'
      ? rawPayload.max_tokens
      : undefined;
  if (typeof maxOutputTokens === 'number') translated.max_output_tokens = maxOutputTokens;
  if (rawPayload.stream === true) translated.stream = true;
  if (typeof rawPayload.temperature === 'number') translated.temperature = rawPayload.temperature;
  if (typeof rawPayload.top_p === 'number') translated.top_p = rawPayload.top_p;
  if (Array.isArray(rawPayload.stop_sequences) && rawPayload.stop_sequences.length > 0) {
    translated.stop = rawPayload.stop_sequences;
  }

  const tools = translateTools(rawPayload.tools);
  if (tools) translated.tools = tools;

  const toolChoice = translateToolChoice(rawPayload.tool_choice);
  if (toolChoice !== undefined) translated.tool_choice = toolChoice;

  const reasoning = translateReasoning(rawPayload.thinking);
  if (reasoning) translated.reasoning = reasoning;

  const metadata = normalizeMetadata(rawPayload.metadata);
  if (metadata) translated.metadata = metadata;

  const userId = isRecord(rawPayload.metadata) && typeof rawPayload.metadata.user_id === 'string'
    ? rawPayload.metadata.user_id
    : undefined;
  if (userId && userId.trim().length > 0) translated.user = userId.trim();

  return { upstreamModel, payload: translated };
}

export function compatCodexDefaultModel(): string {
  return resolveCompatCodexDefaultModel();
}

export function anthropicToOpenAi(payload: unknown): Record<string, unknown> {
  return translateAnthropicToOpenAi({ payload }).payload;
}
