import { handleGetUsageAnalytics } from './handler';

export async function GET(req: Request): Promise<Response> {
  return handleGetUsageAnalytics(req);
}
