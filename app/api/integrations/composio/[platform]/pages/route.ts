import { handleComposioPages } from '../../handlers';

export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return handleComposioPages(req, platform);
}

export async function POST(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return handleComposioPages(req, platform);
}
