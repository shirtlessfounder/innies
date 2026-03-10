import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  createAnalyticsPageAccessResponse,
  getAnalyticsAccessFailure,
} from './lib/analyticsAccess';

export function middleware(request: NextRequest) {
  const failure = getAnalyticsAccessFailure(request.headers);
  if (failure) {
    return createAnalyticsPageAccessResponse(failure);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/analytics', '/api/analytics/:path*'],
};
