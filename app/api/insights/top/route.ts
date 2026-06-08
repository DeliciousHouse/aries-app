import { handleGetInsightsTop } from '@/backend/insights/top/handler';

export async function GET(req: Request) {
  return handleGetInsightsTop(req);
}
