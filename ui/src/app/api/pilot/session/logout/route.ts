import { NextRequest, NextResponse } from 'next/server';
import { PilotServerError, fetchPilotJson } from '../../../../../lib/pilot/server';
import { pilotSessionCookieOptions } from '../../../../../lib/pilot/sessionCookie';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    await fetchPilotJson({
      path: '/v1/pilot/session/logout',
      method: 'POST',
      cookieHeader: request.headers.get('cookie')
    });
  } catch (error) {
    if (!(error instanceof PilotServerError)) {
      throw error;
    }
  }

  const response = NextResponse.redirect(new URL('/pilot', request.url), { status: 303 });
  response.cookies.set('innies_pilot_session', '', pilotSessionCookieOptions(request.url, { maxAge: 0 }));
  return response;
}
