import { NextRequest, NextResponse } from 'next/server';
import {
  PilotServerError,
  fetchAdminJson,
  getPilotConnectedAccounts,
  getPilotSession
} from '../../../../lib/pilot/server';

export const dynamic = 'force-dynamic';

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const returnTo = readFormString(formData, 'returnTo') || '/pilot';
  const credentialId = readFormString(formData, 'credentialId');
  const fiveHourReservePercent = Number(readFormString(formData, 'fiveHourReservePercent'));
  const sevenDayReservePercent = Number(readFormString(formData, 'sevenDayReservePercent'));
  const cookieHeader = request.headers.get('cookie');

  try {
    const session = await getPilotSession(cookieHeader);
    if (!session) {
      return NextResponse.redirect(new URL('/pilot', request.url));
    }

    const accounts = await getPilotConnectedAccounts(cookieHeader);
    const account = accounts.find((entry) => entry.credentialId === credentialId);
    if (!account || account.orgId !== session.effectiveOrgId) {
      return NextResponse.json({
        code: 'pilot_reserve_floor_error',
        message: 'Connected account not found in the current pilot org'
      }, { status: 404 });
    }

    await fetchAdminJson({
      path: `/v1/admin/token-credentials/${credentialId}/contribution-cap`,
      method: 'PATCH',
      body: {
        fiveHourReservePercent,
        sevenDayReservePercent
      }
    });

    return NextResponse.redirect(new URL(returnTo, request.url));
  } catch (error) {
    if (error instanceof PilotServerError) {
      return NextResponse.json({
        code: 'pilot_reserve_floor_error',
        message: error.message,
        details: error.details
      }, { status: error.status });
    }
    throw error;
  }
}
