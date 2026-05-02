import { NextResponse } from 'next/server';
import { mapAriesExecutionError } from '../../../../backend/execution';
import { startOnboarding } from '../../../../backend/onboarding/start';

export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  let result;
  try {
    result = await startOnboarding(payload);
  } catch (error) {
    const mapped = mapAriesExecutionError(error);
    if (mapped) {
      return NextResponse.json(
        {
          onboarding_status: 'error',
          reason: mapped.body.reason,
          message: mapped.body.error,
        },
        { status: mapped.status }
      );
    }
    throw error;
  }

  if (result.status === 'ok') {
    return NextResponse.json(
      {
        status: 'ok',
        tenant_id: result.tenant_id,
        tenant_type: result.tenant_type,
        signup_event_id: result.signup_event_id,
        onboarding_status: result.state
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
      message: typeof result.raw === 'object' && result.raw && 'message' in result.raw
        ? String((result.raw as { message?: string }).message)
        : undefined,
      reason: result.reason
    },
    { status: code }
  );
}
