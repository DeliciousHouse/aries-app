import { handleOauthReconnectHttp } from '../../../../../../backend/integrations/reconnect';

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return handleOauthReconnectHttp(req, provider);
}
