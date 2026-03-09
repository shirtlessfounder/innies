export type AnalyticsWindow = '24h' | '7d' | '1m' | 'all';

export type AnalyticsSource = 'openclaw' | 'cli-claude' | 'cli-codex' | 'direct';

const CANONICAL_WINDOWS = new Set<AnalyticsWindow>(['24h', '7d', '1m', 'all']);
const ANALYTICS_SOURCES = new Set<AnalyticsSource>(['openclaw', 'cli-claude', 'cli-codex', 'direct']);

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function normalizeAnalyticsWindow(value: unknown, fallback: AnalyticsWindow = '24h'): AnalyticsWindow {
  const raw = readString(value)?.toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (raw === '30d') {
    return '1m';
  }

  return CANONICAL_WINDOWS.has(raw as AnalyticsWindow) ? (raw as AnalyticsWindow) : fallback;
}

export function extractTokenCredentialId(routeDecision: unknown): string | null {
  const record = readObject(routeDecision);
  if (!record) {
    return null;
  }

  return readString(record.tokenCredentialId);
}

export function classifyAnalyticsSource(input: {
  provider: unknown;
  routeDecision?: unknown;
}): AnalyticsSource {
  const provider = readString(input.provider)?.toLowerCase();
  const routeDecision = readObject(input.routeDecision);
  const requestSource = readString(routeDecision?.request_source)?.toLowerCase();
  if (requestSource && ANALYTICS_SOURCES.has(requestSource as AnalyticsSource)) {
    return requestSource as AnalyticsSource;
  }
  const selectionReason = readString(routeDecision?.provider_selection_reason);
  const openclawRunId = readString(routeDecision?.openclaw_run_id);

  if (selectionReason === 'cli_provider_pinned') {
    return provider === 'openai' ? 'cli-codex' : 'cli-claude';
  }

  if (openclawRunId) {
    return 'openclaw';
  }

  return 'direct';
}

export function getPercentile(values: readonly number[], percentile: number): number | null {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(Math.max(percentile, 0), 100);
  const index = Math.ceil((clamped / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

export function getP50P95(values: readonly number[]): { p50: number | null; p95: number | null } {
  return {
    p50: getPercentile(values, 50),
    p95: getPercentile(values, 95)
  };
}

export function truncatePreview(value: unknown, maxChars = 500): string | null {
  const text = readString(value);
  if (!text) {
    return null;
  }

  const safeMaxChars = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 500;
  return text.slice(0, safeMaxChars);
}
