import { handleGetInsightsComments } from '@/backend/insights/read-api';

export async function GET(req: Request) {
  return handleGetInsightsComments(req);
}
