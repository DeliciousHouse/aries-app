import { handleGetInsightsGoal } from '@/backend/insights/goal/handler';

export async function GET(req: Request) {
  return handleGetInsightsGoal(req);
}
