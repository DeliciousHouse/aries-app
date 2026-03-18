import { handlePlatformConnectionsGet } from './handlers';

export async function GET(_req: Request) {
  return handlePlatformConnectionsGet();
}
