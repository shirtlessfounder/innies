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

  it('skips tool_result with missing tool_use_id instead of falling back', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'tokyo' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', content: 'sunny' }
            ]
          }
        ]
      }
    });

    const toolOutputs = (translated.payload.input as any[]).filter((i: any) => i.type === 'function_call_output');
    expect(toolOutputs).toHaveLength(0);
  });

  it('skips tool_use with missing id instead of generating synthetic ID', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'get_weather', input: { city: 'tokyo' } }
            ]
          }
        ]
      }
    });

    const toolCalls = (translated.payload.input as any[]).filter((i: any) => i.type === 'function_call');
    expect(toolCalls).toHaveLength(0);
  });

  it('skips tool blocks that do not carry a valid call_id source', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 128,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'before missing tool' },
              { type: 'tool_use', name: 'lookup_repo', input: { name: 'innies' } },
              { type: 'text', text: 'after missing tool' }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', content: [{ type: 'text', text: 'missing tool_use_id result' }] },
              { type: 'text', text: 'continue' }
            ]
          }
        ]
      }
    });

    expect(translated.payload.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'before missing tool'
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'after missing tool'
      },
      {
        type: 'message',
        role: 'user',
        content: 'continue'
      }
    ]);
    expect((translated.payload.input as Array<Record<string, unknown>>).some((item) => item.type === 'function_call')).toBe(false);
    expect((translated.payload.input as Array<Record<string, unknown>>).some((item) => item.type === 'function_call_output')).toBe(false);
  });

  it('serializes mixed tool_result content as full JSON array', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'analyze', input: {} }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'result text' },
                  { type: 'json', data: { score: 42 } }
                ]
              }
            ]
          }
        ]
      }
    });

    const toolOutput = (translated.payload.input as any[]).find((i: any) => i.type === 'function_call_output');
    expect(toolOutput).toBeDefined();
    const parsed = JSON.parse(toolOutput.output);
    expect(parsed).toEqual([
      { type: 'text', text: 'result text' },
      { type: 'json', data: { score: 42 } }
    ]);
  });

  it('joins pure-text tool_result arrays naturally without JSON wrapping', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'line one' },
                  { type: 'text', text: 'line two' }
                ]
              }
            ]
          }
        ]
      }
    });

    const toolOutput = (translated.payload.input as any[]).find((i: any) => i.type === 'function_call_output');
    expect(toolOutput.output).toBe('line one\nline two');
  });

  it('serializes mixed tool_result arrays as full JSON while preserving pure-text arrays as newline-joined text', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_mixed',
                content: [
                  { type: 'text', text: 'foo' },
                  { type: 'json', data: { x: 1 } }
                ]
              },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_text',
                content: [
                  { type: 'text', text: 'line 1' },
                  { type: 'text', text: 'line 2' }
                ]
              }
            ]
          }
        ]
      }
    });

    expect(translated.payload.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'toolu_mixed',
        output: JSON.stringify([
          { type: 'text', text: 'foo' },
          { type: 'json', data: { x: 1 } }
        ])
      },
      {
        type: 'function_call_output',
        call_id: 'toolu_text',
        output: 'line 1\nline 2'
      }
    ]);
  });

  it('preserves whitespace and code blocks in text content', () => {
    const codeBlock = '  function hello() {\n    return "world";\n  }';
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        system: codeBlock,
        messages: [
          { role: 'user', content: '  leading spaces and trailing newline\n' }
        ]
      }
    });

    expect(translated.payload.instructions).toBe(codeBlock);
    const userMsg = (translated.payload.input as any[]).find((i: any) => i.role === 'user');
    expect(userMsg.content).toBe('  leading spaces and trailing newline\n');
  });

  it('preserves whitespace fidelity for multi-line system and message text blocks', () => {
    const translated = translateAnthropicToOpenAi({
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 128,
        system: [
          { type: 'text', text: 'System block line 1\n  indented line 2\n' }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '  function demo() {\n    return 1;\n  }' },
              { type: 'text', text: 'next line stays separate' }
            ]
          }
        ]
      }
    });

    expect(translated.payload.instructions).toBe('System block line 1\n  indented line 2\n');
    expect(translated.payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: '  function demo() {\n    return 1;\n  }\nnext line stays separate'
      }
    ]);
  });
});
