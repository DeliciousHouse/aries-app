import { handleGetMarketingWorkspaceAsset } from './handler';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string; assetId: string }> },
) {
  const { jobId, assetId } = await params;
  return handleGetMarketingWorkspaceAsset(jobId, assetId);
}
