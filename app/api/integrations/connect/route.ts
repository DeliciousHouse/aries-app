import { oauthConnect } from '../../../../backend/integrations/connect';
import { getTenantContext, type TenantContext } from '@/lib/tenant-context';
import { buildOauthConnectInput } from '@/lib/oauth-connect-input';

export async function POST(req: Request) {
  let tenantContext: TenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return new Response(
      JSON.stringify({
        broker_status: 'error',
        reason: 'missing_required_fields',
        message: error instanceof Error ? error.message : 'Authentication required.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );
  }

  const input = await buildOauthConnectInput(req, tenantContext);
  const result = await oauthConnect(input.provider, input.payload);

  const status =
    result.broker_status === 'ok'
      ? 200
      : result.reason === 'already_connected'
        ? 409
        : 400;

  return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
}
