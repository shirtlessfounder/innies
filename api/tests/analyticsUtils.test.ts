import { describe, expect, it } from 'vitest';
import {
  classifyAnalyticsSource,
  extractTokenCredentialId,
  formatDisplayKey,
  getP50P95,
  getPercentile,
  normalizeAnalyticsWindow,
  truncatePreview
} from '../src/utils/analytics.js';

describe('analytics utils', () => {
  describe('normalizeAnalyticsWindow', () => {
    it('keeps canonical windows', () => {
      expect(normalizeAnalyticsWindow('5h')).toBe('5h');
      expect(normalizeAnalyticsWindow('24h')).toBe('24h');
      expect(normalizeAnalyticsWindow('7d')).toBe('7d');
      expect(normalizeAnalyticsWindow('1m')).toBe('1m');
      expect(normalizeAnalyticsWindow('all')).toBe('all');
    });

    it('normalizes 30d to 1m', () => {
      expect(normalizeAnalyticsWindow('30d')).toBe('1m');
      expect(normalizeAnalyticsWindow(' 30D ')).toBe('1m');
    });

    it('falls back for empty or invalid inputs', () => {
      expect(normalizeAnalyticsWindow(undefined)).toBe('24h');
      expect(normalizeAnalyticsWindow(null)).toBe('24h');
      expect(normalizeAnalyticsWindow('wat')).toBe('24h');
      expect(normalizeAnalyticsWindow('wat', '7d')).toBe('7d');
    });
  });

  describe('extractTokenCredentialId', () => {
    it('reads tokenCredentialId from routing metadata', () => {
      expect(extractTokenCredentialId({ tokenCredentialId: 'cred_123' })).toBe('cred_123');
    });

    it('ignores sellerKeyId-only rows for token analytics identity', () => {
      expect(extractTokenCredentialId({ sellerKeyId: 'seller_123' })).toBeNull();
      expect(extractTokenCredentialId({ sellerKeyId: 'seller_123', tokenCredentialId: 'cred_456' })).toBe('cred_456');
    });
  });

  describe('formatDisplayKey', () => {
    it('formats stable short credential and api-key display fallbacks', () => {
      expect(formatDisplayKey('11111111-1111-4111-8111-111111111111', 'cred')).toBe('cred_1111...1111');
      expect(formatDisplayKey('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'key')).toBe('key_aaaa...eeee');
    });

    it('returns null for empty values', () => {
      expect(formatDisplayKey(undefined)).toBeNull();
      expect(formatDisplayKey('')).toBeNull();
    });
  });

  describe('classifyAnalyticsSource', () => {
    it('prefers explicit request_source over legacy openclaw heuristics', () => {
      expect(classifyAnalyticsSource({
        provider: 'anthropic',
        routeDecision: {
          request_source: 'direct',
          openclaw_run_id: 'run_req_default',
          provider_selection_reason: 'preferred_provider_selected'
        }
      })).toBe('direct');
    });

    it('classifies openclaw requests from routing metadata', () => {
      expect(classifyAnalyticsSource({
        provider: 'anthropic',
        routeDecision: {
          openclaw_run_id: 'oc_run_1',
          provider_selection_reason: 'preferred_provider_selected'
        }
      })).toBe('openclaw');
    });

    it('classifies claude-pinned cli requests', () => {
      expect(classifyAnalyticsSource({
        provider: 'anthropic',
        routeDecision: {
          openclaw_run_id: 'oc_run_1',
          provider_selection_reason: 'cli_provider_pinned'
        }
      })).toBe('cli-claude');
    });

    it('classifies codex-pinned cli requests', () => {
      expect(classifyAnalyticsSource({
        provider: 'openai',
        routeDecision: {
          provider_selection_reason: 'cli_provider_pinned'
        }
      })).toBe('cli-codex');
    });

    it('falls back to direct for non-openclaw non-cli requests', () => {
      expect(classifyAnalyticsSource({
        provider: 'anthropic',
        routeDecision: {
          provider_selection_reason: 'preferred_provider_selected'
        }
      })).toBe('direct');
    });
  });

  describe('percentiles', () => {
    it('calculates p50 and p95 for latency windows', () => {
      expect(getP50P95([100, 200, 300, 400, 500])).toEqual({ p50: 300, p95: 500 });
      expect(getP50P95([280, 320, 450, 600, 650])).toEqual({ p50: 450, p95: 650 });
    });

    it('handles singleton and empty datasets', () => {
      expect(getPercentile([], 50)).toBeNull();
      expect(getP50P95([320])).toEqual({ p50: 320, p95: 320 });
    });
  });

  describe('truncatePreview', () => {
    it('keeps short previews unchanged', () => {
      expect(truncatePreview('hello')).toBe('hello');
    });

    it('truncates prompt and response previews to 500 chars by default', () => {
      const preview = 'x'.repeat(700);
      expect(truncatePreview(preview)).toBe('x'.repeat(500));
    });

    it('returns null for empty or non-string values', () => {
      expect(truncatePreview('')).toBeNull();
      expect(truncatePreview(null)).toBeNull();
      expect(truncatePreview({})).toBeNull();
    });
  });
});
