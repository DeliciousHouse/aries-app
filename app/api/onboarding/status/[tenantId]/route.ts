import { NextResponse } from 'next/server';
import { getOnboardingStatus } from '../../../../../backend/onboarding/status';

function progressHintFor(provisioningStatus: string) {
  switch (provisioningStatus) {
    case 'validated':
      return 'validated';
    case 'needs_repair':
      return 'repair_needed';
    case 'duplicate':
      return 'duplicate_request';
    case 'in_progress':
      return 'waiting_for_validation';
    default:
      return 'not_started';
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const url = new URL(req.url);
  const signup_event_id = url.searchParams.get('signup_event_id') || undefined;

  const result = getOnboardingStatus({
    tenant_id: tenantId,
    signup_event_id
  });

  if (result.status === 'ok') {
    return NextResponse.json(
      {
        request_status: 'ok',
        onboarding_status: 'ok',
        tenant_id: result.tenant_id,
        signup_event_id: result.signup_event_id,
        provisioning_status: result.state,
        validation_status: result.validation_status,
        progress_hint: progressHintFor(result.state ?? 'not_found'),
        artifacts: {
          draft: Boolean(result.paths?.draft),
          validated: Boolean(result.paths?.validated),
          validation_report: Boolean(result.paths?.validation_report),
          idempotency_marker: Boolean(result.paths?.idempotency_marker)
        }
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    {
      onboarding_status: 'error',
      reason: result.reason
    },
    { status: 400 }
  );
}
