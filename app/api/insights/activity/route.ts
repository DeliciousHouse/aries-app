import { handleGetInsightsActivity } from '@/backend/insights/activity/handler';

export async function GET(req: Request) {
  return handleGetInsightsActivity(req);
}
