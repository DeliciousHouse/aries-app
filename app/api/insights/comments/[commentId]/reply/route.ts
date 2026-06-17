import { handleReplyToComment } from './handler';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ commentId: string }> },
) {
  const { commentId } = await params;
  return handleReplyToComment(req, commentId);
}
