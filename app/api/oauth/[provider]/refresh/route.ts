import { oauthRefresh } from '../../../../../backend/integrations/refresh';

export async function POST(req: Request, { params }: { params: { provider: string } }) {
  let body: { tenant_id?: string } = {};
  try { body = await req.json(); } catch {}
  const result = await oauthRefresh(params.provider, body.tenant_id);
  const status = result.broker_status === 'ok' ? 200 : 400;
  return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
}
