import { NextResponse } from 'next/server';

import { recordMarketingReviewDecision } from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handlePostMarketingReviewDecision(
  reviewId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let payload: { action?: unknown; actedBy?: unknown; note?: unknown } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const action = typeof payload.action === 'string' ? payload.action : '';
  const actedBy = typeof payload.actedBy === 'string' ? payload.actedBy : '';
  const note = typeof payload.note === 'string' ? payload.note : undefined;

  if (!['approve', 'changes_requested', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }
  if (!actedBy.trim()) {
    return NextResponse.json({ error: 'actedBy is required.' }, { status: 400 });
  }

  const review = await recordMarketingReviewDecision({
    tenantId: tenantResult.tenantContext.tenantId,
    reviewId,
    action: action as 'approve' | 'changes_requested' | 'reject',
    actedBy,
    note,
  });

  if (!review) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }

  return NextResponse.json({ review }, { status: 200 });
}

export async function POST(req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return handlePostMarketingReviewDecision(reviewId, req);
}
