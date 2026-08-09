import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { workspaceMismatchResponse } from '@/lib/tenant-context-http';
import { ensureResearchJobSchema } from '@/backend/memory/research-jobs';
import {
  isPromotionAction,
  resolveQueuedFinding,
} from '@/backend/memory/promote-finding';

/**
 * S6-5 / AA-118 (gap F8) — POST /api/memory/findings/[findingId]/resolve
 *
 * Approve / Edit / Reject a queued memory candidate. Body:
 *   { action: 'approve' | 'edit' | 'reject', editedClaim?: string }
 *
 * tenant_admin ONLY, mirroring the review-queue GET this acts on. Human-only by
 * construction — no AI caller, no autonomous path, and promotion is exactly the
 * human gate `curator_decision='queue_for_review'` was always meant to have.
 *
 * A finding belonging to another tenant returns 404, not 403: the tenant filter
 * is in the SQL, so a cross-tenant id is indistinguishable from a missing one
 * and its existence is never confirmed.
 *
 * Deliberately NOT behind ARIES_WEEKLY_RESULTS_ENABLED. That flag means "the
 * weekly results panel"; coupling an unrelated rollout to it would make one
 * switch mean two things. The only genuinely risky half — the outbound Honcho
 * write — already self-gates on isHonchoEnabled(), so the kill switch exists
 * where the risk is.
 */
export async function handleResolveMemoryFinding(
  req: Request,
  findingId: string,
): Promise<Response> {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    const mismatch = workspaceMismatchResponse(error);
    if (mismatch) return mismatch;
    return NextResponse.json({ error: 'Authentication required.' }, { status: 403 });
  }

  if (tenantContext.role !== 'tenant_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: { action?: unknown; editedClaim?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; editedClaim?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!isPromotionAction(body.action)) {
    return NextResponse.json(
      { error: 'invalid_action', message: 'Use action=approve, edit or reject.' },
      { status: 400 },
    );
  }

  const editedClaim = typeof body.editedClaim === 'string' ? body.editedClaim : null;

  const client = await pool.connect();
  try {
    await ensureResearchJobSchema(client);
    const outcome = await resolveQueuedFinding(
      { findingId, tenantCtx: tenantContext, action: body.action, editedClaim },
      { db: client },
    );

    switch (outcome.status) {
      case 'not_found':
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      case 'invalid':
        return NextResponse.json({ error: outcome.reason }, { status: 400 });
      case 'already_resolved':
        // Idempotent: report the settled state rather than double-writing.
        return NextResponse.json(
          { findingId, status: outcome.decision, alreadyResolved: true },
          { status: 200 },
        );
      case 'ok':
        return NextResponse.json(
          {
            findingId: outcome.findingId,
            status: outcome.decision,
            // False means the local decision stands but the memory append did
            // not happen (Honcho off or unavailable) — surfaced rather than
            // implied, so the UI never claims a memory that does not exist.
            memoryWritten: outcome.memoryWritten,
          },
          { status: 200 },
        );
    }
  } catch (error) {
    console.error('[memory-finding-resolve] failed', error);
    return NextResponse.json({ error: 'resolve_failed' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const { findingId } = await params;
  return handleResolveMemoryFinding(req, findingId);
}
