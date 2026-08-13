import { handleGetInsightsWeeklyRecap } from '@/backend/insights/weekly-recap/handler';

export async function GET(req: Request) {
  return handleGetInsightsWeeklyRecap(req);
}
