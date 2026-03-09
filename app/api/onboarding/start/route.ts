import { NextResponse } from 'next/server';
import { startOnboarding } from '../../../../backend/onboarding/start';

export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const result = await startOnboarding(payload);

  if (result.status === 'ok') {
    return NextResponse.json(
      {
        status: 'ok',
        tenant_id: result.tenant_id,
        tenant_type: result.tenant_type,
        signup_event_id: result.signup_event_id,
        onboarding_status: result.state,
        workflow_status: result.workflow_status,
        raw: result.raw
      },
      { status: 200 }
    );
  }

  const code = result.reason?.startsWith('missing_required_fields') ? 400 : 502;
  return NextResponse.json(
    {
      onboarding_status: 'error',
      tenant_id: result.tenant_id,
      tenant_type: result.tenant_type,
      signup_event_id: result.signup_event_id,
      workflow_status: result.workflow_status,
      raw: result.raw,
      reason: result.reason
    },
    { status: code }
  );
}
