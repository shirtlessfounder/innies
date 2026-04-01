import { describe, expect, it } from 'vitest';
import type { NormalizedArchiveMessage } from '../src/services/archive/archiveTypes.js';
import {
  classifyTaskCategory,
  deriveAssistantTextPreview,
  deriveInterestingnessScore,
  deriveRequestSignals,
  deriveTaskTags,
  deriveUserMessagePreview
} from '../src/services/adminAnalysis/adminAnalysisDerivation.js';

function message(role: NormalizedArchiveMessage['role'], content: NormalizedArchiveMessage['content']): NormalizedArchiveMessage {
  return { role, content };
}

describe('admin analysis derivation', () => {
  it('derives the last user message preview instead of the system prompt', () => {
    const preview = deriveUserMessagePreview([
      message('system', [{ type: 'text', text: 'obey repo policy' }]),
      message('user', [{ type: 'text', text: 'first task' }]),
      message('assistant', [{ type: 'text', text: 'working' }]),
      message('user', [{ type: 'text', text: 'fix the postgres migration failure' }])
    ]);

    expect(preview).toBe('fix the postgres migration failure');
  });

  it('falls back to the last text-bearing request content when no user role exists', () => {
    const preview = deriveUserMessagePreview([
      message('system', [{ type: 'text', text: 'global policy' }]),
      message('assistant', [{ type: 'text', text: 'assistant-only replay' }])
    ]);

    expect(preview).toBe('assistant-only replay');
  });

  it('derives assistant text from normalized response messages', () => {
    const preview = deriveAssistantTextPreview({
      responseMessages: [
        message('assistant', [
          { type: 'text', text: 'First answer paragraph.' },
          { type: 'tool_call', id: 'tool_1', name: 'grep', arguments: { pattern: 'foo' } },
          { type: 'text', text: 'Second answer paragraph.' }
        ])
      ]
    });

    expect(preview).toBe('First answer paragraph.\nSecond answer paragraph.');
  });

  it('falls back to SSE payload parsing and ignores transport wrapper text', () => {
    const preview = deriveAssistantTextPreview({
      responseMessages: [],
      rawResponse: [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_1"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
        'data: {"type":"content_block_delta","delta":{"text":" world"}}',
        'data: [DONE]'
      ].join('\n')
    });

    expect(preview).toBe('Hello\nworld');
  });

  it('truncates long previews to the bounded v1 limit', () => {
    const preview = deriveUserMessagePreview([
      message('user', [{ type: 'text', text: 'x'.repeat(2500) }])
    ]);

    expect(preview).toHaveLength(2000);
  });

  it('classifies tasks and tags deterministically from the user message first', () => {
    const userMessagePreview = 'debug the postgres migration failure in this typescript api route';

    expect(classifyTaskCategory({
      userMessagePreview,
      assistantTextPreview: 'I traced the error to the migration contract.'
    })).toBe('debugging');
    expect(deriveTaskTags({
      userMessagePreview,
      assistantTextPreview: 'The fix touches the typescript api route and postgres migration.'
    })).toEqual(expect.arrayContaining(['postgres', 'migration', 'typescript']));
  });

  it('derives mechanical request signals and interestingness score', () => {
    const signals = deriveRequestSignals({
      attemptNo: 2,
      status: 'partial',
      inputTokens: 45_000,
      outputTokens: 5_000,
      requestMessages: [
        message('user', [{ type: 'text', text: 'run the tool and inspect logs' }])
      ],
      responseMessages: [
        message('assistant', [{ type: 'tool_call', id: 'tool_1', name: 'logs', arguments: {} }])
      ],
      providerFallbackFrom: 'anthropic'
    });

    expect(signals).toEqual({
      isRetry: true,
      isFailure: false,
      isPartial: true,
      isHighToken: true,
      isCrossProviderRescue: true,
      hasToolUse: true
    });
    expect(deriveInterestingnessScore(signals)).toBeGreaterThan(0);
  });
});
