import { NextResponse } from 'next/server';

import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { RuntimeReviewDecisionError, recordMarketingReviewDecision } from '@/backend/marketing/runtime-views';
import { OpenClawGatewayError } from '@/backend/openclaw/gateway-client';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

function decodeReviewIdParam(reviewId: string): string {
  try {
    return decodeURIComponent(reviewId);
  } catch {
    return reviewId;
  }
}

export async function handlePostMarketingReviewDecision(
  reviewId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const decodedReviewId = decodeReviewIdParam(reviewId);
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const tenantId = tenantResult.tenantContext.tenantId;

  if (!tenantId) {
    return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
  }

  let payload: { action?: unknown; actedBy?: unknown; note?: unknown; approvalId?: unknown } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const action = typeof payload.action === 'string' ? payload.action : '';
  const actedBy = typeof payload.actedBy === 'string' ? payload.actedBy : '';
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : undefined;

  if (!['approve', 'changes_requested', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }
  if (!actedBy.trim()) {
    return NextResponse.json({ error: 'actedBy is required.' }, { status: 400 });
  }

  try {
    const review = await recordMarketingReviewDecision({
      tenantId,
      reviewId: decodedReviewId,
      action: action as 'approve' | 'changes_requested' | 'reject',
      actedBy,
      note,
      approvalId,
    });

    if (!review) {
      return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    }

    invalidateMarketingJobStatus(review.jobId);

    return NextResponse.json({ review }, { status: 200 });
  } catch (error) {
    if (error instanceof RuntimeReviewDecisionError) {
      return NextResponse.json(
        {
          error: error.message,
          reason: error.code,
        },
        { status: error.status },
      );
    }
    if (error instanceof OpenClawGatewayError) {
      const status =
        error.code === 'openclaw_gateway_unauthorized'
          ? 401
          : error.code === 'openclaw_gateway_unreachable' || error.code === 'openclaw_gateway_not_configured'
            ? 503
            : error.status || 500;
      return NextResponse.json(
        {
          error: error.message,
          reason: error.code,
        },
        { status },
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return handlePostMarketingReviewDecision(reviewId, req);
}
