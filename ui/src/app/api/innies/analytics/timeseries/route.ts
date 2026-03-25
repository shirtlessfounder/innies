import {
  AnalyticsServerError,
  getAnalyticsSeries,
  normalizePageWindow,
} from '../../../../../lib/analytics/server';
import type { AnalyticsMetric, AnalyticsPageWindow } from '../../../../../lib/analytics/types';
import { INNIES_INTERNAL_ORG_ID } from '../../../../../lib/org/internal';

export const dynamic = 'force-dynamic';

function normalizeMetric(value: string | null | undefined): AnalyticsMetric {
  const normalized = (value ?? '').trim();
  if (
    normalized === 'usageUnits'
    || normalized === 'requests'
    || normalized === 'latencyP50Ms'
    || normalized === 'errorRate'
  ) {
    return normalized;
  }
  return 'usageUnits';
}

function normalizeEntityType(value: string | null | undefined): 'token' | 'buyer' {
  return (value ?? '').trim().toLowerCase() === 'buyer' ? 'buyer' : 'token';
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const window = normalizePageWindow(searchParams.get('window')) as AnalyticsPageWindow;
    const entityType = normalizeEntityType(searchParams.get('entityType'));
    const entityId = searchParams.get('entityId')?.trim();

    if (!entityId) {
      return Response.json(
        {
          code: 'invalid_request',
          message: 'Missing entityId',
        },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      );
    }

    const metric = normalizeMetric(searchParams.get('metric'));
    const series = await getAnalyticsSeries({
      window,
      entityType,
      entityId,
      metric,
      orgId: INNIES_INTERNAL_ORG_ID,
    });

    return Response.json(series, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof AnalyticsServerError) {
      return Response.json(
        {
          code: 'analytics_error',
          message: error.message,
          details: error.details,
        },
        {
          status: error.status,
          headers: { 'cache-control': 'no-store' },
        },
      );
    }

    return Response.json(
      {
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unexpected analytics failure',
      },
      {
        status: 500,
        headers: { 'cache-control': 'no-store' },
      },
    );
  }
}
