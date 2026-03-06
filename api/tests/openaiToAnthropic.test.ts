import { describe, expect, it } from 'vitest';
import { mapOpenAiErrorToAnthropic, translateOpenAiToAnthropic } from '../src/utils/openaiToAnthropic.js';

describe('translateOpenAiToAnthropic', () => {
  it('maps text, tool calls, reasoning, and usage back to anthropic message format', () => {
    const translated = translateOpenAiToAnthropic({
      model: 'claude-opus-4-6',
      data: {
        id: 'resp_123',
        status: 'completed',
        usage: { input_tokens: 11, output_tokens: 7 },
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            content: 'thinking aloud'
          },
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello there' }]
          },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'lookup_repo',
            arguments: '{"name":"innies"}'
          }
        ]
      }
    });

    expect(translated).toEqual({
      id: 'resp_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [
        { type: 'thinking', thinking: 'thinking aloud' },
        { type: 'text', text: 'hello there' },
        { type: 'tool_use', id: 'call_1', name: 'lookup_repo', input: { name: 'innies' } }
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 7 }
    });
  });

  it('maps openai error statuses into anthropic error envelopes', () => {
    expect(mapOpenAiErrorToAnthropic(400, { error: { message: 'bad input' } })).toEqual({
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'bad input'
        }
      }
    });

    expect(mapOpenAiErrorToAnthropic(503, { error: { message: 'upstream down' } })).toEqual({
      status: 500,
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'upstream down'
        }
      }
    });
  });
});
