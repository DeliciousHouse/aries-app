import { handleOauthConnectHttp } from '../../../../../../backend/integrations/connect';

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return handleOauthConnectHttp(req, provider);
}
