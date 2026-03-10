import { oauthDisconnect } from '../../../../backend/integrations/disconnect';
import { oauthStatus } from '../../../../backend/integrations/status';

export async function POST(req: Request) {
  const body = await req.json();
  const provider = String(body.platform || '').toLowerCase();
  const tenantId = body.tenant_id || 'tenant_demo_001';
  const status = oauthStatus(provider, tenantId);
  if ('broker_status' in status || !status.integration_id) {
    return new Response(JSON.stringify({ broker_status: 'error', reason: 'connection_not_found', provider }), { status: 404, headers: { 'content-type': 'application/json' } });
  }

  const result = await oauthDisconnect(provider, { connection_id: status.integration_id });
  return new Response(JSON.stringify(result), { status: result.broker_status === 'ok' ? 200 : 400, headers: { 'content-type': 'application/json' } });
}
