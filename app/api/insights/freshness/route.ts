import { handleGetInsightsFreshness } from '@/backend/insights/freshness/handler';

// Uncached freshness stamp — see backend/insights/freshness/handler.ts.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handleGetInsightsFreshness(req);
}
