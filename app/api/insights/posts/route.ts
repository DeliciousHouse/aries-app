import { handleGetInsightsPosts } from '@/backend/insights/read-api';

export async function GET(req: Request) {
  return handleGetInsightsPosts(req);
}
