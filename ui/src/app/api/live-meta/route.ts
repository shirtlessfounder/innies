import { NextResponse } from 'next/server';
import {
  AnalyticsServerError,
  getAnalyticsDashboardSnapshot,
} from '../../../lib/analytics/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snapshot = await getAnalyticsDashboardSnapshot('24h');
    return NextResponse.json(
      {
        liveStatus: 'live',
        lastSuccessfulUpdateAt: snapshot.snapshotAt,
      },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    const message = error instanceof AnalyticsServerError
      ? error.message
      : (error instanceof Error ? error.message : 'Unexpected live-meta failure');

    return NextResponse.json(
      {
        liveStatus: 'degraded',
        lastSuccessfulUpdateAt: null,
        message,
      },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  }
}
