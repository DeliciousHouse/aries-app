import { handleGetMarketingJobStatus } from './handler';
import { handleDeleteMarketingJob } from './delete/handler';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  return handleGetMarketingJobStatus(jobId);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  return handleDeleteMarketingJob(jobId);
}
