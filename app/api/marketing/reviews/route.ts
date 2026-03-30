import { NextResponse } from 'next/server';

import { listMarketingReviewItemsForTenant, listPublicMarketingReviewItems } from '@/backend/marketing/runtime-views';
import { isMarketingPublicMode } from '@/lib/marketing-public-mode';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingReviews(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    if (isMarketingPublicMode()) {
      return NextResponse.json({ reviews: await listPublicMarketingReviewItems() }, { status: 200 });
    }
    return tenantResult.response;
  }

  const reviews = await listMarketingReviewItemsForTenant(tenantResult.tenantContext.tenantId);
  return NextResponse.json({ reviews }, { status: 200 });
}

export async function GET() {
  return handleGetMarketingReviews();
}
