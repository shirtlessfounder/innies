import { describe, expect, it } from 'vitest';
import { deriveDashboardTokenStatusRow } from '../src/services/dashboardTokenStatus.js';

describe('deriveDashboardTokenStatusRow', () => {
  it('marks backend maxed tokens as benched from backend source', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'maxed',
      rateLimitedUntil: null
    })).toEqual({
      rawStatus: 'maxed',
      compactStatus: 'benched',
      expandedStatus: 'benched, source: backend_maxed',
      statusSource: 'backend_maxed',
      exclusionReason: null,
      hidden: false
    });
  });

  it('appends auth diagnosis details for backend maxed tokens when present', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'maxed',
      rateLimitedUntil: null,
      authDiagnosis: 'access_token_expired_local',
      accessTokenExpiresAt: '2026-03-14T15:49:35.000Z',
      refreshTokenState: 'missing'
    })).toEqual({
      rawStatus: 'maxed',
      compactStatus: 'benched',
      expandedStatus: 'benched, source: backend_maxed, auth: access_token_expired_local, refresh: missing',
      statusSource: 'backend_maxed',
      exclusionReason: null,
      hidden: false
    });
  });

  it('marks active cap-exhausted tokens as benched from cap exhaustion', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'active',
      rateLimitedUntil: null,
      fiveHourReservePercent: 20,
      fiveHourUtilizationRatio: 0.81,
      fiveHourContributionCapExhausted: true,
      fiveHourResetsAt: '2026-03-12T14:00:00.000Z',
      providerUsageFetchedAt: '2026-03-12T12:00:00.000Z'
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'benched',
      expandedStatus: 'benched, source: cap_exhausted',
      statusSource: 'cap_exhausted',
      exclusionReason: null,
      hidden: false
    });
  });

  it('marks active Codex usage-exhausted tokens as benched from provider usage exhaustion', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'active',
      rateLimitedUntil: null,
      fiveHourUtilizationRatio: 1,
      fiveHourResetsAt: '2026-03-12T14:00:00.000Z',
      providerUsageFetchedAt: '2026-03-12T12:00:00.000Z'
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'benched',
      expandedStatus: 'benched, source: usage_exhausted',
      statusSource: 'usage_exhausted',
      exclusionReason: null,
      hidden: false
    });
  });

  it('marks cooldowns as active* with rate_limited exclusion', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'active',
      rateLimitedUntil: '2099-03-08T12:00:00.000Z'
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: rate_limited',
      statusSource: null,
      exclusionReason: 'rate_limited',
      hidden: false
    });
  });

  it('marks escalated repeated 429 holds separately from ordinary cooldowns', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'active',
      rateLimitedUntil: '2099-03-08T12:00:00.000Z',
      consecutiveRateLimitCount: 15,
      fiveHourReservePercent: 20,
      providerUsageFetchedAt: '2026-03-12T12:00:00.000Z',
      fiveHourUtilizationRatio: 0.5,
      fiveHourContributionCapExhausted: false,
      sevenDayContributionCapExhausted: false,
      now: '2026-03-12T12:03:00.000Z'
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: rate_limited (escalated)',
      statusSource: null,
      exclusionReason: 'rate_limited_escalated',
      hidden: false
    });
  });

  it('prioritizes active cooldown over snapshot_missing for Anthropic tokens', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'active',
      rateLimitedUntil: '2099-03-08T12:00:00.000Z',
      fiveHourReservePercent: 20,
      providerUsageFetchedAt: null
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: rate_limited',
      statusSource: null,
      exclusionReason: 'rate_limited',
      hidden: false
    });
  });

  it('prioritizes escalated rate limiting over snapshot_stale for Anthropic tokens', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'active',
      rateLimitedUntil: '2099-03-08T12:00:00.000Z',
      consecutiveRateLimitCount: 15,
      fiveHourReservePercent: 20,
      providerUsageFetchedAt: '2026-03-12T12:00:00.000Z',
      fiveHourUtilizationRatio: 0.5,
      fiveHourContributionCapExhausted: false,
      sevenDayContributionCapExhausted: false,
      now: '2026-03-12T12:20:01.000Z'
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: rate_limited (escalated)',
      statusSource: null,
      exclusionReason: 'rate_limited_escalated',
      hidden: false
    });
  });

  it('marks reserved Claude tokens with missing provider usage as snapshot_missing', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'active',
      rateLimitedUntil: null,
      fiveHourReservePercent: 20,
      providerUsageFetchedAt: null
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: snapshot_missing',
      statusSource: null,
      exclusionReason: 'snapshot_missing',
      hidden: false
    });
  });

  it('marks reserved Claude tokens with hard-stale provider usage as snapshot_stale', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'anthropic',
      rawStatus: 'active',
      rateLimitedUntil: null,
      fiveHourReservePercent: 20,
      providerUsageFetchedAt: '2026-03-12T12:00:00.000Z',
      fiveHourUtilizationRatio: 0.5,
      now: '2026-03-12T12:20:01.000Z'
    })).toEqual({
      rawStatus: 'active',
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: snapshot_stale',
      statusSource: null,
      exclusionReason: 'snapshot_stale',
      hidden: false
    });
  });

  it('passes through paused and rotating statuses unchanged', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'paused',
      rateLimitedUntil: null
    })).toEqual({
      rawStatus: 'paused',
      compactStatus: 'paused',
      expandedStatus: 'paused',
      statusSource: null,
      exclusionReason: null,
      hidden: false
    });

    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'rotating',
      rateLimitedUntil: null
    })).toEqual({
      rawStatus: 'rotating',
      compactStatus: 'rotating',
      expandedStatus: 'rotating',
      statusSource: null,
      exclusionReason: null,
      hidden: false
    });
  });

  it('hides expired and revoked statuses', () => {
    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'expired',
      rateLimitedUntil: null
    }).hidden).toBe(true);

    expect(deriveDashboardTokenStatusRow({
      provider: 'openai',
      rawStatus: 'revoked',
      rateLimitedUntil: null
    }).hidden).toBe(true);
  });
});
