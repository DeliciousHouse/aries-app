import { handleGetInsightsAttention } from '@/backend/insights/attention/handler';

export async function GET(req: Request) {
  return handleGetInsightsAttention(req);
}
