import { NextResponse } from 'next/server';

import {
  getVariantBoard,
  recordVariantPick,
  type RecordVariantPickResult,
  type VariantBoardView,
} from '@/backend/marketing/onboarding-variant-batch';
import { finalizeVariantPick } from '@/backend/marketing/variant-pick-finalize';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete onboarding before viewing the first-post variant board.',
} as const;

/** Tenant-scoped read of a variant board's state for the onboarding UI to poll. */
export async function handleVariantBoardGet(
  batchId: string,
  opts: {
    tenantContextLoader?: TenantContextLoader;
    getBoard?: (args: { batchId: string; tenantId: string }) => Promise<VariantBoardView | null>;
  } = {},
): Promise<Response> {
  const id = (batchId ?? '').trim();
  if (!id) {
    return NextResponse.json({ status: 'error', reason: 'missing_batch_id' }, { status: 400 });
  }

  const tenantResult = await loadTenantContextOrResponse(opts.tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = tenantResult.tenantContext.tenantId;

  const getBoard = opts.getBoard ?? getVariantBoard;
  const board = await getBoard({ batchId: id, tenantId });
  if (!board) {
    // Unknown batch OR tenant mismatch — same 404 so existence is not leaked.
    return NextResponse.json({ status: 'error', reason: 'variant_board_not_found' }, { status: 404 });
  }
  return NextResponse.json({ status: 'ok', board });
}

/** Tenant-scoped pick: record the chosen variant + release it to publish. */
export async function handleVariantPickPost(
  batchId: string,
  body: unknown,
  opts: {
    tenantContextLoader?: TenantContextLoader;
    recordPick?: (args: {
      batchId: string;
      tenantId: string;
      selectedVariantIndex: number;
      selectedCreativeId: string | null;
    }) => Promise<RecordVariantPickResult>;
    finalize?: typeof finalizeVariantPick;
  } = {},
): Promise<Response> {
  const id = (batchId ?? '').trim();
  if (!id) {
    return NextResponse.json({ status: 'error', reason: 'missing_batch_id' }, { status: 400 });
  }

  const tenantResult = await loadTenantContextOrResponse(opts.tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = tenantResult.tenantContext.tenantId;

  const payload = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const rawIndex = payload.selectedVariantIndex ?? payload.variantIndex;
  const selectedVariantIndex =
    typeof rawIndex === 'number' ? rawIndex : Number.parseInt(String(rawIndex ?? '').trim(), 10);
  if (!Number.isInteger(selectedVariantIndex) || selectedVariantIndex < 0) {
    return NextResponse.json({ status: 'error', reason: 'invalid_selected_variant' }, { status: 400 });
  }
  const rawCreative = payload.selectedVariantId ?? payload.selectedCreativeId;
  const selectedCreativeId = typeof rawCreative === 'string' && rawCreative.trim() ? rawCreative.trim() : null;

  const ratings = Array.isArray(payload.ratings)
    ? (payload.ratings as unknown[])
        .map((r) => {
          const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
          return { variantIndex: Number(o.variantIndex), score: Number(o.score) };
        })
        .filter((r) => Number.isInteger(r.variantIndex) && Number.isFinite(r.score))
    : [];
  const edits = Array.isArray(payload.edits)
    ? (payload.edits as unknown[])
        .map((e) => {
          const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
          return {
            variantIndex: Number(o.variantIndex),
            op: String(o.op ?? ''),
            instruction: typeof o.instruction === 'string' ? o.instruction : undefined,
          };
        })
        .filter((e) => Number.isInteger(e.variantIndex) && e.op.length > 0)
    : [];

  const recordPick = opts.recordPick ?? recordVariantPick;
  const result = await recordPick({ batchId: id, tenantId, selectedVariantIndex, selectedCreativeId });

  switch (result.kind) {
    case 'picked': {
      // Phase 4: dual taste write + Phase-B anchored generation. Non-fatal — the
      // pick (post #1) is already finalized; a finalize failure must not 500.
      const finalize = opts.finalize ?? finalizeVariantPick;
      try {
        await finalize({
          tenantCtx: tenantResult.tenantContext,
          batchId: id,
          pickedVariantIndex: result.pickedVariantIndex,
          pickedCreativeId: selectedCreativeId,
          ratings,
          edits,
        });
      } catch (err) {
        console.warn('[variant-pick] finalize (taste + Phase-B) failed — pick still recorded', err);
      }
      return NextResponse.json({
        status: 'ok',
        pickedVariantIndex: result.pickedVariantIndex,
        finalizedJobId: result.finalizedJobId,
      });
    }
    case 'already_resolved':
      return NextResponse.json({ status: 'ok', alreadyResolved: true, pickedVariantIndex: result.pickedVariantIndex });
    case 'invalid_variant':
      return NextResponse.json({ status: 'error', reason: 'invalid_selected_variant' }, { status: 400 });
    case 'not_found':
    case 'tenant_mismatch':
    default:
      // 404 for both unknown + tenant mismatch so existence is not leaked.
      return NextResponse.json({ status: 'error', reason: 'variant_board_not_found' }, { status: 404 });
  }
}
