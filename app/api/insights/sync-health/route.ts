import { handleGetInsightsSyncHealth } from '@/backend/insights/sync-health/handler';

// Uncached sync-health detail — see backend/insights/sync-health/handler.ts.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handleGetInsightsSyncHealth(req);
}
