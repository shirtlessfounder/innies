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

  try {
    const response = await fetchPilotJson<{ ok: true; checkoutUrl: string }>({
      path: '/v1/pilot/payments/setup-session',
      method: 'POST',
      cookieHeader: request.headers.get('cookie'),
      body: {
        returnTo
      }
    });
    return NextResponse.redirect(response.checkoutUrl, { status: 303 });
  } catch (error) {
    if (error instanceof PilotServerError) {
      return NextResponse.json({
        code: 'pilot_payments_setup_error',
        message: error.message,
        details: error.details
      }, { status: error.status });
    }
    throw error;
  }
}
