import { handlePublishDispatch } from './handler';

export async function POST(req: Request) {
  return handlePublishDispatch(req);
}
