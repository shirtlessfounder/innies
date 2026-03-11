import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsApiAccessResponse, getAnalyticsAccessFailure } from '../../../../lib/analyticsAccess';
import {
  AnalyticsServerError,
  getAnalyticsSeries,
  normalizePageWindow,
} from '../../../../lib/analytics/server';
import type { AnalyticsMetric, AnalyticsPageWindow } from '../../../../lib/analytics/types';

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

export async function GET(request: NextRequest) {
  try {
    const accessFailure = getAnalyticsAccessFailure(request.headers);
    if (accessFailure) {
      return createAnalyticsApiAccessResponse(accessFailure);
    }

    const window = normalizePageWindow(request.nextUrl.searchParams.get('window')) as AnalyticsPageWindow;
    const entityType = normalizeEntityType(request.nextUrl.searchParams.get('entityType'));
    const entityId = request.nextUrl.searchParams.get('entityId')?.trim();

    if (!entityId) {
      return NextResponse.json(
        {
          code: 'invalid_request',
          message: 'Missing entityId',
        },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      );
    }

    const metric = normalizeMetric(request.nextUrl.searchParams.get('metric'));
    const series = await getAnalyticsSeries({ window, entityType, entityId, metric });

    return NextResponse.json(series, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof AnalyticsServerError) {
      return NextResponse.json(
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

    return NextResponse.json(
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
