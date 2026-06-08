import { handleGetInsightsNarrative } from '@/backend/insights/narrative/handler';

export async function GET(req: Request) {
  return handleGetInsightsNarrative(req);
}
