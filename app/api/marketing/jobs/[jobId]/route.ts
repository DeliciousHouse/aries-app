import { handleGetMarketingJobStatus } from './handler';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  return handleGetMarketingJobStatus(jobId);
}
