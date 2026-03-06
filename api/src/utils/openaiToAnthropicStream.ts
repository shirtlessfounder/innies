import { Transform } from 'node:stream';

type OpenAiToAnthropicStreamOptions = {
  model: string;
};

type OutputKind = 'text' | 'tool_use' | 'thinking';

type OutputState = {
  blockIndex: number;
  kind: OutputKind;
  sawDelta: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textFromMessageItem(item: Record<string, unknown>): string {
  return asArray(item.content)
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .filter((part) => (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('');
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class OpenAiToAnthropicStreamTransform extends Transform {
  private readonly model: string;
  private buffer = '';
  private started = false;
  private messageId = `msg_${Date.now()}`;
  private nextBlockIndex = 0;
  private readonly outputStates = new Map<number, OutputState>();
  private pendingFunctionOutputIndex: number | null = null;
  private sawToolUse = false;

  constructor(options: OpenAiToAnthropicStreamOptions) {
    super();
    this.model = options.model;
  }

  override _transform(chunk: Buffer | Uint8Array | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      if (typeof chunk === 'string') {
        this.buffer += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        this.buffer += chunk.toString('utf8');
      } else {
        this.buffer += Buffer.from(chunk).toString('utf8');
      }
      this.buffer = this.buffer.replace(/\r\n/g, '\n');

      let boundaryIndex = this.buffer.indexOf('\n\n');
      while (boundaryIndex >= 0) {
        const rawRecord = this.buffer.slice(0, boundaryIndex);
        this.buffer = this.buffer.slice(boundaryIndex + 2);
        this.processRecord(rawRecord);
        boundaryIndex = this.buffer.indexOf('\n\n');
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      const trailing = this.buffer.trim();
      if (trailing.length > 0) {
        this.processRecord(trailing);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private ensureMessageStart(response?: Record<string, unknown>): void {
    if (this.started) return;
    if (response && typeof response.id === 'string' && response.id.trim().length > 0) {
      this.messageId = response.id;
    }
    this.push(sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }));
    this.started = true;
  }

  private processRecord(rawRecord: string): void {
    const trimmed = rawRecord.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) return;

    let explicitEvent: string | undefined;
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        explicitEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') return;

    let payload: unknown;
    try {
      payload = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;

    const type = typeof payload.type === 'string' ? payload.type : explicitEvent;
    if (!type) return;

    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        this.ensureMessageStart(isRecord(payload.response) ? payload.response : undefined);
        break;
      case 'response.output_item.added':
        this.handleOutputItemAdded(payload);
        break;
      case 'response.content_part.added':
        this.handleContentPartAdded(payload);
        break;
      case 'response.output_text.delta':
        this.handleOutputTextDelta(payload);
        break;
      case 'response.function_call_arguments.delta':
        this.handleFunctionCallArgumentsDelta(payload);
        break;
      case 'response.output_item.done':
        this.handleOutputItemDone(payload);
        break;
      case 'response.completed':
        this.handleCompleted(payload);
        break;
      default:
        break;
    }
  }

  private allocateState(outputIndex: number, kind: OutputKind): OutputState {
    const existing = this.outputStates.get(outputIndex);
    if (existing) return existing;
    const state: OutputState = {
      blockIndex: this.nextBlockIndex,
      kind,
      sawDelta: false
    };
    this.nextBlockIndex += 1;
    this.outputStates.set(outputIndex, state);
    return state;
  }

  private ensureBlockStart(outputIndex: number, item: Record<string, unknown>, kind: OutputKind): OutputState {
    const existing = this.outputStates.get(outputIndex);
    if (existing) return existing;

    const state = this.allocateState(outputIndex, kind);
    if (kind === 'text') {
      this.push(sseEvent('content_block_start', {
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'text', text: '' }
      }));
      return state;
    }

    if (kind === 'tool_use') {
      const toolUseId = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.id === 'string'
          ? item.id
          : `call_${outputIndex}`;
      this.push(sseEvent('content_block_start', {
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: typeof item.name === 'string' ? item.name : 'tool',
          input: {}
        }
      }));
      this.pendingFunctionOutputIndex = outputIndex;
      this.sawToolUse = true;
      return state;
    }

    this.push(sseEvent('content_block_start', {
      type: 'content_block_start',
      index: state.blockIndex,
      content_block: { type: 'thinking', thinking: '' }
    }));
    return state;
  }

  private handleOutputItemAdded(payload: Record<string, unknown>): void {
    this.ensureMessageStart();
    const outputIndex = Number(payload.output_index ?? 0);
    const item = isRecord(payload.item) ? payload.item : null;
    if (!item || typeof item.type !== 'string') return;

    if (item.type === 'message') {
      this.ensureBlockStart(outputIndex, item, 'text');
      return;
    }

    if (item.type === 'function_call') {
      this.ensureBlockStart(outputIndex, item, 'tool_use');
      return;
    }

    if (item.type === 'reasoning') {
      this.ensureBlockStart(outputIndex, item, 'thinking');
    }
  }

  private handleContentPartAdded(payload: Record<string, unknown>): void {
    const outputIndex = Number(payload.output_index ?? 0);
    const part = isRecord(payload.part) ? payload.part : null;
    if (!part || part.type !== 'output_text') return;
    this.ensureBlockStart(outputIndex, {}, 'text');
  }

  private handleOutputTextDelta(payload: Record<string, unknown>): void {
    this.ensureMessageStart();
    const outputIndex = Number(payload.output_index ?? 0);
    const state = this.ensureBlockStart(outputIndex, {}, 'text');
    state.sawDelta = true;
    this.push(sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: {
        type: state.kind === 'thinking' ? 'thinking_delta' : 'text_delta',
        ...(state.kind === 'thinking'
          ? { thinking: typeof payload.delta === 'string' ? payload.delta : '' }
          : { text: typeof payload.delta === 'string' ? payload.delta : '' })
      }
    }));
  }

  private handleFunctionCallArgumentsDelta(payload: Record<string, unknown>): void {
    this.ensureMessageStart();
    const outputIndex = typeof payload.output_index === 'number'
      ? payload.output_index
      : this.pendingFunctionOutputIndex;
    if (outputIndex == null) return;
    const state = this.outputStates.get(outputIndex) ?? this.allocateState(outputIndex, 'tool_use');
    state.sawDelta = true;
    this.push(sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: typeof payload.delta === 'string' ? payload.delta : ''
      }
    }));
  }

  private handleOutputItemDone(payload: Record<string, unknown>): void {
    this.ensureMessageStart();
    const outputIndex = Number(payload.output_index ?? 0);
    const item = isRecord(payload.item) ? payload.item : null;
    if (!item || typeof item.type !== 'string') return;
    const kind = item.type === 'function_call' ? 'tool_use' : item.type === 'reasoning' ? 'thinking' : 'text';
    const hadState = this.outputStates.has(outputIndex);
    const state = hadState
      ? this.outputStates.get(outputIndex)!
      : this.ensureBlockStart(outputIndex, item, kind);

    if (!state.sawDelta) {
      if (item.type === 'message') {
        const text = textFromMessageItem(item);
        if (text.length > 0) {
          this.push(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: { type: 'text_delta', text }
          }));
        }
      } else if (item.type === 'function_call') {
        const argumentsJson = typeof item.arguments === 'string' ? item.arguments : '';
        if (argumentsJson.length > 0) {
          this.push(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argumentsJson }
          }));
        }
      } else if (item.type === 'reasoning') {
        const thinking = typeof item.content === 'string'
          ? item.content
          : typeof item.summary === 'string'
            ? item.summary
            : '';
        if (thinking.length > 0) {
          this.push(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: { type: 'thinking_delta', thinking }
          }));
        }
      }
    }

    this.push(sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: state.blockIndex
    }));
  }

  private handleCompleted(payload: Record<string, unknown>): void {
    this.ensureMessageStart(isRecord(payload.response) ? payload.response : undefined);
    const response = isRecord(payload.response) ? payload.response : {};
    const usage = isRecord(response.usage) ? response.usage : {};
    const inputTokens = Number(usage.input_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? 0);
    const stopReason = this.sawToolUse
      ? 'tool_use'
      : response.status === 'incomplete' && isRecord(response.incomplete_details) && response.incomplete_details.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'end_turn';

    this.push(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    }));
    this.push(sseEvent('message_stop', { type: 'message_stop' }));
  }
}
