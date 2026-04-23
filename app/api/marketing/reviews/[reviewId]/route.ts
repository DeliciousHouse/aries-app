import { NextResponse } from 'next/server';

import { lookupMarketingReviewItemForTenant } from '@/backend/marketing/runtime-views';
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

  const lookup = await lookupMarketingReviewItemForTenant(
    tenantResult.tenantContext.tenantId,
    decodedReviewId,
  );
  if (lookup.status === 'wrong_workspace') {
    return NextResponse.json(
      {
        error: 'review_not_in_current_workspace',
        message: 'This review belongs to a different workspace than the one currently active for your account.',
      },
      { status: 409 },
    );
  }
  if (lookup.status !== 'ok') {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }

  return NextResponse.json({ review: lookup.review }, { status: 200 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return handleGetMarketingReviewItem(reviewId);
}
