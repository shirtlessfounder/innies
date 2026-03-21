import { NextRequest, NextResponse } from 'next/server';
import { PilotServerError, fetchAdminJson } from '../../../../../lib/pilot/server';

export const dynamic = 'force-dynamic';

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  try {
    const response = await fetchAdminJson<{ ok: true; sessionToken: string }>({
      path: '/v1/admin/pilot/session',
      method: 'POST',
      body: {
        mode: 'impersonation',
        targetUserId: readFormString(formData, 'targetUserId'),
        targetOrgId: readFormString(formData, 'targetOrgId'),
        targetOrgSlug: readFormString(formData, 'targetOrgSlug') || undefined,
        targetOrgName: readFormString(formData, 'targetOrgName') || undefined,
        githubLogin: readFormString(formData, 'githubLogin') || undefined,
        userEmail: readFormString(formData, 'userEmail') || undefined
      }
    });

    const redirect = NextResponse.redirect(new URL('/pilot', request.url));
    redirect.cookies.set('innies_pilot_session', response.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/'
    });
    return redirect;
  } catch (error) {
    if (error instanceof PilotServerError) {
      return NextResponse.json({
        code: 'admin_pilot_impersonation_error',
        message: error.message,
        details: error.details
      }, { status: error.status });
    }
    throw error;
  }
}
