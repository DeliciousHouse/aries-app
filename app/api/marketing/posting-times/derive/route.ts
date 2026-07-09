import { handleDerivePostingTimes } from '../handler';

export async function POST(req: Request): Promise<Response> {
  return handleDerivePostingTimes(req);
}
