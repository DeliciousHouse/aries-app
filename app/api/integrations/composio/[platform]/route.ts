import { handleComposioDisconnect } from '../handlers';

export async function DELETE(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return handleComposioDisconnect(platform);
}
