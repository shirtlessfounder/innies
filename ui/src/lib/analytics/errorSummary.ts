const MAX_ERROR_MESSAGE_CHARS = 240;

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function truncateSummary(value: string): string {
  return value.length <= MAX_ERROR_MESSAGE_CHARS
    ? value
    : `${value.slice(0, MAX_ERROR_MESSAGE_CHARS - 1).trimEnd()}...`;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
    }

    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
    }

    return HTML_ENTITY_MAP[normalized] ?? `&${entity};`;
  });
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeHtmlText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = decodeHtmlEntities(stripHtml(value)).replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function summarizeHtmlDocument(value: string): string | null {
  const trimmed = value.trimStart();
  const looksLikeHtml = /^<!doctype html\b/i.test(trimmed)
    || /^<html\b/i.test(trimmed)
    || /<html[\s>]/i.test(trimmed);
  if (!looksLikeHtml) return null;

  const title = normalizeHtmlText(value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const heading = normalizeHtmlText(value.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1])
    ?? normalizeHtmlText(value.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]);

  let summary = title ?? heading ?? 'HTML response received from upstream';
  if (summary.includes('|')) {
    summary = summary.split('|').at(-1)?.trim() ?? summary;
  }
  summary = summary.replace(/^(\d{3})\s*:\s*/u, '$1 ');

  if (/\bcloudflare\b/i.test(value) && !/\bcloudflare\b/i.test(summary)) {
    summary = `Cloudflare ${summary}`;
  }

  return truncateSummary(summary);
}

export function summarizeAnalyticsErrorText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Unexpected upstream response';
  }

  const htmlSummary = summarizeHtmlDocument(trimmed);
  if (htmlSummary) return htmlSummary;

  return truncateSummary(trimmed.replace(/\s+/g, ' '));
}

export function safeParseAnalyticsBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: summarizeAnalyticsErrorText(text) };
  }
}

export function extractAnalyticsErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== 'string' || message.trim().length === 0) return null;
  return summarizeAnalyticsErrorText(message);
}
