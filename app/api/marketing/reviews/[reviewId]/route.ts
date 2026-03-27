import { NextResponse } from 'next/server';

import { getMarketingReviewItemForTenant } from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

function decodeReviewIdParam(reviewId: string): string {
  try {
    return decodeURIComponent(reviewId);
  } catch {
    return reviewId;
  }
}

export async function handleGetMarketingReviewItem(
  reviewId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const decodedReviewId = decodeReviewIdParam(reviewId);
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const review = await getMarketingReviewItemForTenant(tenantResult.tenantContext.tenantId, decodedReviewId);
  if (!review) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }

  return NextResponse.json({ review }, { status: 200 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return handleGetMarketingReviewItem(reviewId);
}
