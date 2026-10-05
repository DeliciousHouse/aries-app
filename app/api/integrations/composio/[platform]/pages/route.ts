import { handleComposioPages } from '../../handlers';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ platform: string }> };

export async function GET(req: Request, context: Context): Promise<Response> {
  return handleComposioPages(req, (await context.params).platform);
}

export async function POST(req: Request, context: Context): Promise<Response> {
  return handleComposioPages(req, (await context.params).platform);
}
