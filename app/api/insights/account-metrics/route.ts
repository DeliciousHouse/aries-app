import { handleGetInsightsAccountMetrics } from '@/backend/insights/read-api';

export async function GET(req: Request) {
  return handleGetInsightsAccountMetrics(req);
}
