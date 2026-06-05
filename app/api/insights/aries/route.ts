import { handleGetInsightsAries } from '@/backend/insights/aries/handler';

export async function GET(req: Request) {
  return handleGetInsightsAries(req);
}
