import { handlePostMarketingJobs } from './handler';

export async function POST(req: Request) {
  return handlePostMarketingJobs(req);
}
