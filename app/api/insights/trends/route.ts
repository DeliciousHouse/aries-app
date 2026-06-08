import { handleGetInsightsTrends } from '@/backend/insights/trends/handler';

export async function GET(req: Request) {
  return handleGetInsightsTrends(req);
}
