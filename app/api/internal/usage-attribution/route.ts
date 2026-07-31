import { handleGetUsageAttribution } from './handler';

export async function GET(req: Request): Promise<Response> {
  return handleGetUsageAttribution(req);
}
