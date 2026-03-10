import { describe, expect, it } from 'vitest';
import {
  buildSyntheticOpenAiResponsesSse,
  buildSyntheticOpenAiStreamFailureSse,
  hasTerminalOpenAiResponsesStreamEvent,
  summarizeSyntheticOpenAiOutputItems
} from '../src/utils/openaiSyntheticStream.js';

describe('buildSyntheticOpenAiResponsesSse', () => {
  it('builds text output into native Responses SSE events', () => {
    const sse = buildSyntheticOpenAiResponsesSse({
      id: 'resp_text_1',
      model: 'gpt-5.4',
      status: 'completed',
      usage: { input_tokens: 5, output_tokens: 7 },
      output: [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
        status: 'completed'
      }]
    });

    expect(sse).toContain('data: {"type":"response.created"');
    expect(sse).toContain('"type":"response.output_item.added"');
    expect(sse).toContain('"type":"response.output_text.delta"');
    expect(sse).toContain('"delta":"hello"');
    expect(sse).toContain('"type":"response.output_item.done"');
    expect(sse).toContain('"type":"response.completed"');
    expect(sse).toContain('data: [DONE]');
  });

  it('builds function-call output into native Responses SSE events', () => {
    const sse = buildSyntheticOpenAiResponsesSse({
      id: 'resp_tool_1',
      status: 'completed',
      usage: { input_tokens: 4, output_tokens: 3 },
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'lookup_repo',
        arguments: '{"name":"innies"}',
        status: 'completed'
      }]
    });

    expect(sse).toContain('"type":"response.output_item.added"');
    expect(sse).toContain('"type":"response.function_call_arguments.delta"');
    expect(sse).toContain('{\\"name\\":\\"innies\\"}');
    expect(sse).toContain('"type":"response.output_item.done"');
    expect(sse).toContain('"call_id":"call_1"');
    expect(sse).toContain('"type":"response.completed"');
  });

  it('synthesizes a placeholder message item when a response-like payload has no output items', () => {
    const summary = summarizeSyntheticOpenAiOutputItems({
      id: 'resp_empty_1',
      status: 'completed',
      usage: { input_tokens: 2, output_tokens: 0 }
    });
    const sse = buildSyntheticOpenAiResponsesSse({
      id: 'resp_empty_1',
      status: 'completed',
      usage: { input_tokens: 2, output_tokens: 0 }
    });

    expect(summary.count).toBe(1);
    expect(summary.types).toBe('message');
    expect(sse).toContain('"type":"response.output_item.added"');
    expect(sse).toContain('"type":"response.output_item.done"');
    expect(sse).toContain('"type":"response.completed"');
  });

  it('emits response.incomplete for incomplete terminal status', () => {
    const sse = buildSyntheticOpenAiResponsesSse({
      id: 'resp_incomplete_1',
      status: 'incomplete',
      detail: 'tool output truncated'
    });

    expect(sse).toContain('"type":"response.output_item.added"');
    expect(sse).toContain('"type":"response.incomplete"');
    expect(sse).not.toContain('"type":"response.completed"');
  });

  it('builds a terminal failure stream marker for passthrough disconnects', () => {
    const sse = buildSyntheticOpenAiStreamFailureSse({
      id: 'resp_failed_1',
      model: 'gpt-5.4',
      message: 'upstream stream ended before completion'
    });

    expect(sse).toContain('"type":"response.failed"');
    expect(sse).toContain('"code":"stream_disconnected"');
    expect(sse).toContain('data: [DONE]');
    expect(hasTerminalOpenAiResponsesStreamEvent(sse)).toBe(true);
  });
});
