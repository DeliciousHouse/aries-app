import { handleGetPostingTimes } from './handler';

export async function GET(req: Request): Promise<Response> {
  return handleGetPostingTimes(req);
}
