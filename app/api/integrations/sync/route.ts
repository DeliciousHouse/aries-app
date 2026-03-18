import { handleIntegrationsSync } from '../handlers';

export async function POST(req: Request) {
  return handleIntegrationsSync(req);
}
