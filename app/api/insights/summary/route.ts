import { handleGetInsightsSummary } from '@/backend/insights/read-api';

export async function GET(req: Request) {
  return handleGetInsightsSummary(req);
}
