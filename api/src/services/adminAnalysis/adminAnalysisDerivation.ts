import type { NormalizedArchiveContentPart, NormalizedArchiveMessage } from '../archive/archiveTypes.js';
import { truncatePreview } from '../../utils/analytics.js';
import type {
  AdminAnalysisRequestSignals,
  AdminAnalysisTaskCategory,
  AssistantPreviewInput,
  RequestSignalsInput
} from './adminAnalysisTypes.js';

const PREVIEW_MAX_CHARS = 2000;
const HIGH_TOKEN_THRESHOLD = 40_000;

const CATEGORY_RULES: Array<{
  category: AdminAnalysisTaskCategory;
  keywords: string[];
}> = [
  { category: 'debugging', keywords: ['debug', 'bug', 'fix', 'failure', 'failing', 'error', 'broken', 'trace'] },
  { category: 'code_review', keywords: ['review', 'pr', 'pull request', 'code review', 'diff'] },
  { category: 'feature_building', keywords: ['build', 'implement', 'ship', 'add endpoint', 'feature', 'route'] },
  { category: 'research', keywords: ['research', 'investigate', 'compare', 'evaluate', 'look into'] },
  { category: 'ops', keywords: ['deploy', 'infra', 'migration', 'incident', 'rollback', 'ops'] },
  { category: 'writing', keywords: ['write', 'draft', 'docs', 'documentation', 'spec'] },
  { category: 'data_analysis', keywords: ['analytics', 'analyze', 'trend', 'query', 'metric', 'dashboard'] }
];

const TAG_RULES: Array<{ tag: string; keywords: string[] }> = [
  { tag: 'react', keywords: ['react'] },
  { tag: 'typescript', keywords: ['typescript', 'tsconfig', '.ts', '.tsx'] },
  { tag: 'postgres', keywords: ['postgres', 'postgresql', 'sql'] },
  { tag: 'auth', keywords: ['auth', 'oauth', 'token'] },
  { tag: 'billing', keywords: ['billing', 'payment', 'stripe'] },
  { tag: 'migration', keywords: ['migration', 'migrate'] },
  { tag: 'sse', keywords: ['sse', 'event stream', 'streaming'] },
  { tag: 'openai', keywords: ['openai', 'gpt', 'codex'] },
  { tag: 'anthropic', keywords: ['anthropic', 'claude'] },
  { tag: 'deployment', keywords: ['deploy', 'deployment', 'release'] },
  { tag: 'performance', keywords: ['performance', 'latency', 'slow'] },
  { tag: 'api', keywords: ['api', 'endpoint', 'route'] }
];

export function deriveUserMessagePreview(messages: NormalizedArchiveMessage[]): string | null {
  const lastUser = findLastTextBearingMessage(messages, (message) => message.role === 'user');
  if (lastUser) {
    return truncatePreview(lastUser, PREVIEW_MAX_CHARS);
  }

  const fallback = findLastTextBearingMessage(messages, () => true);
  return truncatePreview(fallback, PREVIEW_MAX_CHARS);
}

export function deriveAssistantTextPreview(input: AssistantPreviewInput): string | null {
  const normalized = findLastTextBearingMessage(input.responseMessages, (message) => message.role === 'assistant');
  if (normalized) {
    return truncatePreview(normalized, PREVIEW_MAX_CHARS);
  }

  const sse = parseSseText(input.rawResponse);
  if (sse) {
    return truncatePreview(sse, PREVIEW_MAX_CHARS);
  }

  return truncatePreview(input.rawResponse ?? null, PREVIEW_MAX_CHARS);
}

export function classifyTaskCategory(input: {
  userMessagePreview: string | null;
  assistantTextPreview?: string | null;
}): AdminAnalysisTaskCategory {
  const haystack = normalizeHaystack(input.userMessagePreview, input.assistantTextPreview);
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return rule.category;
    }
  }
  return 'other';
}

export function deriveTaskTags(input: {
  userMessagePreview: string | null;
  assistantTextPreview?: string | null;
}): string[] {
  const haystack = normalizeHaystack(input.userMessagePreview, input.assistantTextPreview);
  return TAG_RULES
    .filter((rule) => rule.keywords.some((keyword) => haystack.includes(keyword)))
    .map((rule) => rule.tag);
}

export function deriveRequestSignals(input: RequestSignalsInput): AdminAnalysisRequestSignals {
  return {
    isRetry: input.attemptNo > 1,
    isFailure: input.status === 'failed',
    isPartial: input.status === 'partial',
    isHighToken: input.inputTokens + input.outputTokens >= HIGH_TOKEN_THRESHOLD,
    isCrossProviderRescue: Boolean(input.providerFallbackFrom),
    hasToolUse: hasToolUse(input.requestMessages) || hasToolUse(input.responseMessages)
  };
}

export function deriveInterestingnessScore(signals: AdminAnalysisRequestSignals): number {
  let score = 0;
  if (signals.isRetry) score += 2;
  if (signals.isFailure) score += 5;
  if (signals.isPartial) score += 3;
  if (signals.isHighToken) score += 4;
  if (signals.isCrossProviderRescue) score += 4;
  if (signals.hasToolUse) score += 1;
  return score;
}

function hasToolUse(messages: NormalizedArchiveMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((part) => part.type === 'tool_call' || part.type === 'tool_result')
  );
}

function findLastTextBearingMessage(
  messages: NormalizedArchiveMessage[],
  predicate: (message: NormalizedArchiveMessage) => boolean
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !predicate(message)) continue;
    const text = collectTextParts(message.content);
    if (text) {
      return text;
    }
  }

  return null;
}

function collectTextParts(parts: NormalizedArchiveContentPart[]): string | null {
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return text.length > 0 ? text : null;
}

function parseSseText(raw: string | null | undefined): string | null {
  if (!raw || !raw.includes('data:')) {
    return null;
  }

  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      collectUnknownText(JSON.parse(payload), parts);
    } catch {
      const cleaned = payload.trim();
      if (cleaned.length > 0 && !cleaned.startsWith('event:')) {
        parts.push(cleaned);
      }
    }
  }

  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

function collectUnknownText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) output.push(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectUnknownText(item, output));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'output_text', 'input_text']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      output.push(candidate.trim());
    }
  }

  for (const key of ['delta', 'content', 'message', 'messages', 'output', 'response', 'item']) {
    collectUnknownText(record[key], output);
  }
}

function normalizeHaystack(...values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase())
    .join('\n');
}
