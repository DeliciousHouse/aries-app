import { handleVariantPickPost } from '../handler';

export async function POST(req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return handleVariantPickPost(batchId, body);
}
