import { handleIntegrationsDisconnect } from '../../../../integrations/handlers';

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const body = await req.json().catch(() => ({}));
  return handleIntegrationsDisconnect(
    new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify({ ...body, platform: provider }),
    })
  );
}
