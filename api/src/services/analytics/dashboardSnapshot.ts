import type { AnalyticsDashboardSnapshotPayload } from '../../repos/analyticsDashboardSnapshotRepository.js';
import type {
  AnalyticsRouteRepository,
  DashboardFilters,
  DashboardSnapshotShape
} from '../../routes/analytics.js';

type DashboardSnapshotRepository = Pick<
  AnalyticsRouteRepository,
  | 'getSystemSummary'
  | 'getTokenUsage'
  | 'getTokenHealth'
  | 'getTokenRouting'
  | 'getBuyers'
  | 'getAnomalies'
  | 'getEvents'
>;

export async function buildDashboardSnapshotPayload(input: {
  analytics: DashboardSnapshotRepository;
  query: DashboardFilters & { orgId?: string };
  shape: DashboardSnapshotShape;
  snapshotAt?: string;
}): Promise<AnalyticsDashboardSnapshotPayload> {
  const snapshotAt = input.snapshotAt ?? new Date().toISOString();
  const [summaryRaw, tokenUsageRaw, tokenHealthRaw, tokenRoutingRaw, buyersRaw, anomaliesRaw, eventsRaw] = await Promise.all([
    input.analytics.getSystemSummary(input.query),
    input.analytics.getTokenUsage(input.query),
    input.analytics.getTokenHealth(input.query),
    input.analytics.getTokenRouting(input.query),
    input.analytics.getBuyers(input.query),
    input.analytics.getAnomalies(input.query),
    input.analytics.getEvents({
      window: input.query.window,
      provider: input.query.provider,
      limit: 20,
      orgId: input.query.orgId
    })
  ]);

  const summary = input.shape.normalizeSystemSummary(summaryRaw);
  const tokenUsage = input.shape.normalizeTokenUsageRows(tokenUsageRaw);
  const tokenHealth = input.shape.normalizeTokenHealthRows(tokenHealthRaw);
  const tokenRouting = input.shape.normalizeTokenRoutingRows(tokenRoutingRaw);
  const buyers = input.shape.normalizeBuyerRows(buyersRaw);
  const anomalies = input.shape.normalizeAnomalies(anomaliesRaw);
  const events = input.shape.normalizeEventRows(eventsRaw);
  const warnings = input.shape.buildProviderUsageWarnings(tokenHealthRaw);
  const tokens = input.shape.mergeDashboardTokens({
    usage: tokenUsage,
    health: tokenHealth,
    routing: tokenRouting
  });

  return {
    window: input.query.window,
    snapshotAt,
    summary: input.shape.deriveDashboardSummaryFromTokens(
      summary,
      tokens,
      tokenUsage.length > 0 || tokenHealth.length > 0 || tokenRouting.length > 0
    ),
    tokens,
    buyers,
    anomalies,
    events,
    warnings
  };
}
