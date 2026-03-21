import { NextRequest, NextResponse } from 'next/server';
import { PilotServerError, fetchPilotJson } from '../../../../lib/pilot/server';

export const dynamic = 'force-dynamic';

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const returnTo = readFormString(formData, 'returnTo') || '/pilot';
  const amountMinor = Number(readFormString(formData, 'amountMinor'));
  const destinationRail = readFormString(formData, 'destinationRail') || 'manual_usdc';
  const destinationAddress = readFormString(formData, 'destinationAddress');
  const note = readFormString(formData, 'note');

  try {
    await fetchPilotJson({
      path: '/v1/pilot/withdrawals',
      method: 'POST',
      cookieHeader: request.headers.get('cookie'),
      body: {
        amountMinor,
        destination: {
          rail: destinationRail,
          address: destinationAddress
        },
        note: note || undefined
      }
    });
    return NextResponse.redirect(new URL(returnTo, request.url));
  } catch (error) {
    if (error instanceof PilotServerError) {
      return NextResponse.json({
        code: 'pilot_withdrawal_error',
        message: error.message,
        details: error.details
      }, { status: error.status });
    }
    throw error;
  }
}
