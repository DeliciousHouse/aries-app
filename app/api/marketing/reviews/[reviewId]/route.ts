import { NextResponse } from 'next/server';

import { getMarketingReviewItemForTenant } from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingReviewItem(
  reviewId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const review = await getMarketingReviewItemForTenant(tenantResult.tenantContext.tenantId, reviewId);
  if (!review) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }

  return NextResponse.json({ review }, { status: 200 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return handleGetMarketingReviewItem(reviewId);
}
