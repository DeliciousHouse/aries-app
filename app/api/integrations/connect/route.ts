import { oauthConnect } from '../../../../backend/integrations/connect';
import { PROVIDER_REGISTRY } from '../../../../backend/integrations/provider-registry';

export async function POST(req: Request) {
  const body = await req.json();
  const provider = String(body.platform || '').toLowerCase();
  const result = await oauthConnect(provider, {
    tenant_id: body.tenant_id || 'tenant_demo_001',
    redirect_uri: body.redirect_uri || `http://localhost:3000/api/oauth/${provider}/callback`,
    scopes: PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]?.default_scopes || []
  });
  return new Response(JSON.stringify(result), { status: result.broker_status === 'ok' ? 200 : 400, headers: { 'content-type': 'application/json' } });
}
