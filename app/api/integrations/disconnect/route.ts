import { handleIntegrationsDisconnect } from '../handlers';

export async function POST(req: Request) {
  return handleIntegrationsDisconnect(req);
}
