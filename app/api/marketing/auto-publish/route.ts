import { handleGetAutoPublish, handlePatchAutoPublish } from './handler';

export async function GET(req: Request) {
  return handleGetAutoPublish(req);
}

export async function PATCH(req: Request) {
  return handlePatchAutoPublish(req);
}
