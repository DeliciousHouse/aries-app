import { handleComposioCapabilities } from '../../handlers';

export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return handleComposioCapabilities(platform);
}
