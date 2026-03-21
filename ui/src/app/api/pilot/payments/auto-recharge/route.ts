import { NextRequest, NextResponse } from 'next/server';
import { PilotServerError, fetchPilotJson } from '../../../../../lib/pilot/server';
import { normalizePilotReturnTo } from '../../../../../lib/pilot/returnTo';

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const returnTo = normalizePilotReturnTo(readFormString(formData, 'returnTo')) ?? '/pilot';
  const enabled = readFormString(formData, 'enabled') === 'true';
  const amountMinor = Number(readFormString(formData, 'amountMinor'));

  try {
    await fetchPilotJson({
      path: '/v1/pilot/payments/auto-recharge',
      method: 'POST',
      cookieHeader: request.headers.get('cookie'),
      body: {
        enabled,
        amountMinor
      }
    });
    return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
  } catch (error) {
    if (error instanceof PilotServerError) {
      return NextResponse.json({
        code: 'pilot_auto_recharge_error',
        message: error.message,
        details: error.details
      }, { status: error.status });
    }
    throw error;
  }
}
