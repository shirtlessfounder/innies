import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsApiAccessResponse, getAnalyticsAccessFailure } from '../../../../lib/analyticsAccess';
import {
  AnalyticsServerError,
  getAnalyticsDashboardSnapshot,
  normalizePageWindow,
} from '../../../../lib/analytics/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const accessFailure = getAnalyticsAccessFailure(request.headers);
    if (accessFailure) {
      return createAnalyticsApiAccessResponse(accessFailure);
    }

    const window = normalizePageWindow(request.nextUrl.searchParams.get('window'));
    const snapshot = await getAnalyticsDashboardSnapshot(window);
    return NextResponse.json(snapshot, {
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
