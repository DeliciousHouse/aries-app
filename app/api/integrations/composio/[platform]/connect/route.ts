import { handleComposioConnect } from '../../handlers';

export async function POST(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return handleComposioConnect(req, platform);
}
