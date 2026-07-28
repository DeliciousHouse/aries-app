import { handleGetBillingQuota } from './handler';

export async function GET(req: Request): Promise<Response> {
  return handleGetBillingQuota(req);
}
