import {
  AnalyticsServerError,
  getAnalyticsDashboardSnapshot,
  normalizePageWindow,
} from '../../../../../lib/analytics/server';
import { INNIES_INTERNAL_ORG_ID } from '../../../../../lib/org/internal';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const window = normalizePageWindow(new URL(request.url).searchParams.get('window'));
    const snapshot = await getAnalyticsDashboardSnapshot(window, {
      orgId: INNIES_INTERNAL_ORG_ID,
    });
    return Response.json(snapshot, {
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
