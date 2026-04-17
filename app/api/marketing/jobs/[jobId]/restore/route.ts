import { handleRestoreMarketingJob } from '../delete/handler';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  return handleRestoreMarketingJob(jobId);
}
