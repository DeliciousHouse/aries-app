import { handleGetLatestMarketingJobStatus } from './handler';

export async function GET() {
  return handleGetLatestMarketingJobStatus();
}
