import { afterEach, describe, expect, it } from 'vitest';
import { translateAnthropicToOpenAi } from '../src/utils/anthropicToOpenai.js';

describe('translateAnthropicToOpenAi', () => {
  afterEach(() => {
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('maps anthropic messages, tool history, tool schemas, and tool choice into responses format', () => {
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';

    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        system: [{ type: 'text', text: 'System rules' }],
        max_tokens: 512,
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ['STOP'],
        thinking: { type: 'enabled', budget_tokens: 4096 },
        tools: [{
          name: 'lookup_repo',
          description: 'lookup repo metadata',
          input_schema: { type: 'object', properties: { name: { type: 'string' } } }
        }],
        tool_choice: { type: 'tool', name: 'lookup_repo' },
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'working' },
              { type: 'tool_use', id: 'toolu_1', name: 'lookup_repo', input: { name: 'innies' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'done' }] }
            ]
          }
        ]
      }
    });

    expect(translated.upstreamModel).toBe('gpt-5.4');
    expect(translated.payload).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'System rules',
      max_output_tokens: 512,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['STOP'],
      tool_choice: { type: 'function', function: { name: 'lookup_repo' } },
      reasoning: { effort: 'high' },
      tools: [{
        type: 'function',
        function: {
          name: 'lookup_repo',
          description: 'lookup repo metadata',
          parameters: { type: 'object', properties: { name: { type: 'string' } } }
        }
      }]
    });
    expect(translated.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'working' },
      { type: 'function_call', call_id: 'toolu_1', name: 'lookup_repo', arguments: '{"name":"innies"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'done' }
    ]);
  });

  it('preserves base64 image blocks and strips cache_control fields', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe image', cache_control: { type: 'ephemeral' } },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc123',
                cache_control: { type: 'ephemeral' }
              }
            }
          ]
        }]
      }
    });

    expect(translated.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe image' },
          { type: 'input_image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }
        ]
      }
    ]);
  });
});
