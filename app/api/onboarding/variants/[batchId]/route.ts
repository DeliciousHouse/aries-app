import { handleVariantBoardGet } from './handler';

export async function GET(_req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return handleVariantBoardGet(batchId);
}
