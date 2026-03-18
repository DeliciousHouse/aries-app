import { NextResponse } from 'next/server';
import { startOnboarding } from '../../../../backend/onboarding/start';
import { OpenClawGatewayError } from '../../../../backend/openclaw/gateway-client';

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
    if (error instanceof OpenClawGatewayError) {
      const status =
        error.code === 'openclaw_gateway_unauthorized'
          ? 401
          : error.code === 'openclaw_gateway_unreachable' || error.code === 'openclaw_gateway_not_configured'
            ? 503
            : error.status || 500;
      return NextResponse.json(
        {
          onboarding_status: 'error',
          reason: error.code,
          message: error.message,
        },
        { status }
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
