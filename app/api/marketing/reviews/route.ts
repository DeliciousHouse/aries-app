import { NextResponse } from 'next/server';

import { listMarketingReviewQueueForTenant } from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingReviews(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const queue = await listMarketingReviewQueueForTenant(tenantResult.tenantContext.tenantId);
  return NextResponse.json(queue, { status: 200 });
}

export async function GET() {
  return handleGetMarketingReviews();
}
