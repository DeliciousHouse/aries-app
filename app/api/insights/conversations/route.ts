import { handleGetInsightsConversations } from '@/backend/insights/conversations/handler';

export async function GET(req: Request) {
  return handleGetInsightsConversations(req);
}
