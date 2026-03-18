import { handleOauthReconnect } from '../../../../integrations/handlers';

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return handleOauthReconnect(req, provider);
}
