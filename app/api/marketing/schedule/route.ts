import { handleGetMarketingSchedule, handlePatchMarketingSchedule } from './handler';

export async function GET(req: Request) {
  return handleGetMarketingSchedule(req);
}

export async function PATCH(req: Request) {
  return handlePatchMarketingSchedule(req);
}
