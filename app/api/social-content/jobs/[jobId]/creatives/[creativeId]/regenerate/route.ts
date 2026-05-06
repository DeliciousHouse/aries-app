import { handleRegenerateCreative } from './handler';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string; creativeId: string }> },
) {
  const { jobId, creativeId } = await params;
  return handleRegenerateCreative(jobId, creativeId, req);
}
