import { handlePostMarketingJobs } from '@/app/api/marketing/jobs/handler';
import type { TenantContextLoader } from '@/lib/tenant-context-http';

export async function handlePostSocialContentJobs(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  return handlePostMarketingJobs(req, tenantContextLoader, { responseDialect: 'social-content' });
}

export async function POST(req: Request) {
  return handlePostSocialContentJobs(req);
}
