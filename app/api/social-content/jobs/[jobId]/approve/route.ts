import { handleApproveMarketingJob } from '@/app/api/marketing/jobs/[jobId]/approve/handler';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return handleApproveMarketingJob(jobId, req, undefined, { responseDialect: 'social-content' });
}
