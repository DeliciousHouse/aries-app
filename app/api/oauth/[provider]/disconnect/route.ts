import { handleOauthDisconnectHttp } from '../../../../../backend/integrations/disconnect';

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return handleOauthDisconnectHttp(req, provider);
}
