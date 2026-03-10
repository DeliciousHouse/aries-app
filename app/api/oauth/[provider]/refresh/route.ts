import { oauthRefresh } from '../../../../../backend/integrations/refresh';

export async function POST(req: Request, { params }: { params: { provider: string } }) {
  let body: { tenant_id?: string; token_expires_in_seconds?: number; refresh_expires_in_seconds?: number } = {};
  try { body = await req.json(); } catch {}
  const result = await oauthRefresh(params.provider, body.tenant_id, {
    token_expires_in_seconds: body.token_expires_in_seconds,
    refresh_expires_in_seconds: body.refresh_expires_in_seconds
  });
  const status = result.broker_status === 'ok' ? 200 : 400;
  return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
}
