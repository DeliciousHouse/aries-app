import { handleOauthCallbackHttp } from '../../../../../../backend/integrations/callback';

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return handleOauthCallbackHttp(req, provider);
}
