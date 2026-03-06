import { describe, expect, it } from 'vitest';
import { OpenAiToAnthropicStreamTransform } from '../src/utils/openaiToAnthropicStream.js';

async function collectTranslatedSse(sse: string): Promise<string> {
  const transform = new OpenAiToAnthropicStreamTransform({ model: 'claude-opus-4-6' });
  const chunks: string[] = [];
  transform.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  });

  await new Promise<void>((resolve, reject) => {
    transform.on('end', resolve);
    transform.on('error', reject);
    transform.end(sse);
  });

  return chunks.join('');
}

describe('OpenAiToAnthropicStreamTransform', () => {
  it('translates text-stream responses into anthropic SSE events', async () => {
    const openAiSse = [
      'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}\n\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hello"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}],"status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":7}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    const translated = await collectTranslatedSse(openAiSse);

    expect(translated).toContain('event: message_start');
    expect(translated).toContain('event: content_block_start');
    expect(translated).toContain('"type":"text_delta"');
    expect(translated).toContain('"text":"hello"');
    expect(translated).toContain('event: content_block_stop');
    expect(translated).toContain('event: message_delta');
    expect(translated).toContain('"stop_reason":"end_turn"');
    expect(translated).toContain('event: message_stop');
  });

  it('translates function_call streams using call_id continuity', async () => {
    const openAiSse = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_repo","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"name\\":\\"innies\\"}"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_repo","arguments":"{\\"name\\":\\"innies\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","usage":{"input_tokens":4,"output_tokens":3}}}\n\n'
    ].join('');

    const translated = await collectTranslatedSse(openAiSse);

    expect(translated).toContain('"type":"tool_use"');
    expect(translated).toContain('"id":"call_1"');
    expect(translated).toContain('"name":"lookup_repo"');
    expect(translated).toContain('"type":"input_json_delta"');
    expect(translated).toContain('{\\"name\\":\\"innies\\"}');
    expect(translated).toContain('"stop_reason":"tool_use"');
  });
});
