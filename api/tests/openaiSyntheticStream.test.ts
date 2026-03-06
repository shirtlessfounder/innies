import { describe, expect, it } from 'vitest';
import { buildSyntheticOpenAiResponsesSse } from '../src/utils/openaiSyntheticStream.js';

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
});
