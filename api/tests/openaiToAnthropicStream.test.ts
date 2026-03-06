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

  it('emits proper terminal events on response.failed', async () => {
    const openAiSse = [
      'data: {"type":"response.created","response":{"id":"resp_fail","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'data: {"type":"response.failed","response":{"id":"resp_fail","status":"failed","error":{"message":"upstream exploded"},"usage":{"input_tokens":5,"output_tokens":0}}}\n\n'
    ].join('');

    const translated = await collectTranslatedSse(openAiSse);

    expect(translated).toContain('event: message_start');
    expect(translated).toContain('event: content_block_start');
    expect(translated).toContain('"type":"text_delta"');
    expect(translated).toContain('upstream exploded');
    expect(translated).toContain('event: content_block_stop');
    expect(translated).toContain('event: message_delta');
    expect(translated).toContain('"stop_reason":"end_turn"');
    expect(translated).toContain('event: message_stop');
  });

  it('treats content_part.done and output_text.done as no-ops', async () => {
    const openAiSse = [
      'data: {"type":"response.created","response":{"id":"resp_noop","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}\n\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hi"}\n\n',
      'data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"hi"}}\n\n',
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"hi"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hi"}],"status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_noop","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
    ].join('');

    const translated = await collectTranslatedSse(openAiSse);

    // Should have exactly one content block (not duplicated by no-op events)
    const blockStarts = (translated.match(/event: content_block_start/g) || []).length;
    const blockStops = (translated.match(/event: content_block_stop/g) || []).length;
    expect(blockStarts).toBe(1);
    expect(blockStops).toBe(1);
    expect(translated).toContain('"text":"hi"');
    expect(translated).toContain('event: message_stop');
  });

  it('uses call_unknown_N fallback for streaming function_call without call_id', async () => {
    const openAiSse = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_nocallid","name":"search","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"q\\":\\"test\\"}"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_nocallid","name":"search","arguments":"{\\"q\\":\\"test\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_3","status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
    ].join('');

    const translated = await collectTranslatedSse(openAiSse);

    expect(translated).toContain('"type":"tool_use"');
    expect(translated).toContain('"id":"call_unknown_0"');
    expect(translated).not.toContain('"id":"fc_nocallid"');
    expect(translated).toContain('"name":"search"');
  });
});
