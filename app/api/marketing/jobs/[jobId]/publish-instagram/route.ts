import { handleInstagramPublish } from './handler';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return handleInstagramPublish(req, jobId);
}
