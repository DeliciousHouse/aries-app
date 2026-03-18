import { handleIntegrationsGet } from './handlers';

export async function GET(_req: Request) {
  return handleIntegrationsGet();
}
