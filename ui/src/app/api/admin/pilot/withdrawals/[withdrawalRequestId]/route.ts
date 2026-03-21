import { NextRequest, NextResponse } from 'next/server';
import { PilotServerError, fetchAdminJson } from '../../../../../../lib/pilot/server';

export const dynamic = 'force-dynamic';

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalInt(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ withdrawalRequestId: string }> }
) {
  const { withdrawalRequestId } = await context.params;
  const formData = await request.formData();
  const action = readFormString(formData, 'action');
  const returnTo = readFormString(formData, 'returnTo') || '/admin/pilot';
  const reason = readFormString(formData, 'reason');
  const settlementReference = readFormString(formData, 'settlementReference');
  const adjustmentMinor = readOptionalInt(readFormString(formData, 'adjustmentMinor'));
  const adjustmentReason = readFormString(formData, 'adjustmentReason');

  let body: Record<string, unknown>;
  switch (action) {
    case 'approve':
      body = {
        action,
        reason: reason || undefined
      };
      break;
    case 'reject':
      body = {
        action,
        reason: reason || 'Rejected from dashboard'
      };
      break;
    case 'mark_settled':
      body = {
        action,
        settlementReference: settlementReference || 'dashboard_settlement',
        adjustmentMinor,
        adjustmentReason: adjustmentReason || undefined
      };
      break;
    case 'mark_settlement_failed':
      body = {
        action,
        settlementFailureReason: reason || adjustmentReason || 'Settlement failed from dashboard',
        adjustmentMinor,
        adjustmentReason: adjustmentReason || undefined
      };
      break;
    default:
      return NextResponse.json({
        code: 'admin_pilot_withdrawal_error',
        message: 'Unsupported withdrawal action'
      }, { status: 400 });
  }

  try {
    await fetchAdminJson({
      path: `/v1/admin/pilot/withdrawals/${withdrawalRequestId}/actions`,
      method: 'POST',
      body
    });
    return NextResponse.redirect(new URL(returnTo, request.url));
  } catch (error) {
    if (error instanceof PilotServerError) {
      return NextResponse.json({
        code: 'admin_pilot_withdrawal_error',
        message: error.message,
        details: error.details
      }, { status: error.status });
    }
    throw error;
  }
}
