import { handleGetMarketingJobAsset } from './handler';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string; assetId: string }> }
) {
  const { jobId, assetId } = await params;
  return handleGetMarketingJobAsset(jobId, assetId, req);
}
