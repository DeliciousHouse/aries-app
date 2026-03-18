import { handleIntegrationsConnect } from '../handlers';

export async function POST(req: Request) {
  return handleIntegrationsConnect(req);
}
