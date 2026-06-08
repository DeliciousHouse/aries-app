import { handleGetInsightsAudience } from '@/backend/insights/audience/handler';

export async function GET(req: Request) {
  return handleGetInsightsAudience(req);
}
