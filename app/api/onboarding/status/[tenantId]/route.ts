import { NextResponse } from 'next/server';
import { getOnboardingStatus } from '../../../../../backend/onboarding/status';

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
        onboarding_status: 'ok',
        tenant_id: result.tenant_id,
        signup_event_id: result.signup_event_id,
        provisioning_status: result.state,
        validation_status: result.validation_status,
        paths: result.paths,
        pathsAreRelative: true
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
