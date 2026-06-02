/**
 * Phase 4 of the onboarding variant board: what happens AFTER a pick is recorded.
 *
 *  1. Dual taste write — the pick (strong approve) and each star rating (graded)
 *     for the variant's taste dimensions are written to the Aries
 *     marketing_taste_profile (fast read-time bias) AND scheduled to Honcho
 *     (durable, cross-session). Edits ride along as edit_ops.
 *  2. Phase B — posts #2-7 of the first week are generated AFTER the pick,
 *     anchored to the chosen variant's visual direction, by starting a normal
 *     weekly job scoped to 6 posts with the anchor injected into the brief.
 *
 * Best-effort + non-fatal: a taste-write or Phase-B failure is logged and the
 * pick still succeeds (the chosen post #1 already published on pick). All side
 * effects are injectable for unit testing.
 */
import { scheduleOnboardingVariantTasteSignalHoncho } from '@/backend/memory';

import {
  approveSocialContentJob,
  startSocialContentJob,
  type ApproveSocialContentJobRequest,
  type ApproveSocialContentJobResponse,
  type StartSocialContentJobRequest,
  type StartSocialContentJobResponse,
} from './orchestrator';
import { VARIANT_LENSES } from './onboarding-variant-batch';
import { loadSocialContentJobRuntime, type SocialContentJobRuntimeDocument } from './runtime-state';
import { applyTasteSignal } from './taste-profile-store';
import { loadVariantBatch, type VariantBatchRecord } from './variant-batch-store';

export type FinalizeTenantCtx = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  role: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';
};

/**
 * Per-variant taste dimensions, aligned to VARIANT_LENSES order. The picked
 * direction's dimensions are reinforced; rated ones are graded. Phase 1's
 * loadTasteForBrief later biases future briefs toward the high-confidence ones.
 */
export const VARIANT_TASTE_DIMENSIONS: ReadonlyArray<ReadonlyArray<{ dimension: string; value: string }>> = [
  [
    { dimension: 'visual_style', value: 'Bold Minimalist' },
    { dimension: 'density', value: 'Airy' },
  ],
  [
    { dimension: 'visual_style', value: 'Warm Editorial' },
    { dimension: 'voice', value: 'Warm Authentic' },
  ],
  [
    { dimension: 'visual_style', value: 'Playful Vibrant' },
    { dimension: 'color_palette', value: 'Saturated' },
  ],
];

/** Map a 1-5 star score to a taste outcome (3 = neutral → no signal). */
export function ratingOutcome(score: number): 'approved' | 'rejected' | null {
  if (!Number.isFinite(score)) return null;
  if (score >= 4) return 'approved';
  if (score <= 2) return 'rejected';
  return null;
}

/** Signal strength = distance from the neutral 3 (5★/1★ → 2, 4★/2★ → 1). */
export function ratingWeight(score: number): number {
  return Math.max(1, Math.abs(Math.round(score) - 3));
}

function ymdUtcToday(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

const BASE_PAYLOAD_KEYS = [
  'brandUrl',
  'websiteUrl',
  'businessName',
  'businessType',
  'approverName',
  'launchApproverName',
  'competitorUrl',
  'goal',
  'primaryGoal',
  'offer',
  'notes',
  'channels',
  'mode',
] as const;

/** Extract the onboarding base payload from a variant job doc, dropping the
 * variant-specific overrides (post count, variant tags, briefs). */
export function extractBasePayload(doc: SocialContentJobRuntimeDocument | null): Record<string, unknown> | null {
  const req = doc?.inputs?.request as Record<string, unknown> | undefined;
  if (!req || typeof req !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const key of BASE_PAYLOAD_KEYS) {
    if (key in req) out[key] = req[key];
  }
  return out;
}

export type FinalizeVariantPickInput = {
  tenantCtx: FinalizeTenantCtx;
  batchId: string;
  pickedVariantIndex: number;
  pickedCreativeId?: string | null;
  ratings?: Array<{ variantIndex: number; score: number }>;
  edits?: Array<{ variantIndex: number; op: string; instruction?: string }>;
};

export type FinalizeVariantPickDeps = {
  applyTaste?: typeof applyTasteSignal;
  scheduleHoncho?: typeof scheduleOnboardingVariantTasteSignalHoncho;
  startJob?: (req: StartSocialContentJobRequest) => Promise<StartSocialContentJobResponse>;
  approveJob?: (
    req: ApproveSocialContentJobRequest,
    doc?: SocialContentJobRuntimeDocument,
  ) => Promise<ApproveSocialContentJobResponse>;
  loadJobDoc?: (jobId: string) => Promise<SocialContentJobRuntimeDocument | null>;
  loadBatch?: (batchId: string) => Promise<VariantBatchRecord | null>;
  now?: Date;
};

export type FinalizeVariantPickResult = {
  tasteSignals: number;
  honchoScheduled: number;
  phaseBJobId: string | null;
};

export async function finalizeVariantPick(
  input: FinalizeVariantPickInput,
  deps: FinalizeVariantPickDeps = {},
): Promise<FinalizeVariantPickResult> {
  const applyTaste = deps.applyTaste ?? applyTasteSignal;
  const scheduleHoncho = deps.scheduleHoncho ?? scheduleOnboardingVariantTasteSignalHoncho;
  const startJob = deps.startJob ?? startSocialContentJob;
  const approveJob = deps.approveJob ?? approveSocialContentJob;
  const loadJobDoc = deps.loadJobDoc ?? loadSocialContentJobRuntime;
  const loadBatch = deps.loadBatch ?? loadVariantBatch;
  const ymd = ymdUtcToday(deps.now ?? new Date());

  const result: FinalizeVariantPickResult = { tasteSignals: 0, honchoScheduled: 0, phaseBJobId: null };

  const batch = await loadBatch(input.batchId);
  if (!batch) return result;
  const { tenantCtx, pickedVariantIndex } = input;

  const ratingByVariant = new Map<number, number>();
  for (const r of input.ratings ?? []) {
    if (Number.isInteger(r?.variantIndex) && Number.isFinite(r?.score)) ratingByVariant.set(r.variantIndex, r.score);
  }
  const editsByVariant = new Map<number, string[]>();
  for (const e of input.edits ?? []) {
    if (!Number.isInteger(e?.variantIndex) || typeof e?.op !== 'string') continue;
    const arr = editsByVariant.get(e.variantIndex) ?? [];
    // Carry the freeform instruction text into the taste signal (it is scrubbed
    // + length-capped by the Honcho writer) so the user's words shape the profile.
    arr.push(e.instruction ? `${e.op}: ${e.instruction}` : e.op);
    editsByVariant.set(e.variantIndex, arr);
  }

  // --- 1. Dual taste write (Aries DB + Honcho) for the pick + each rating ---
  const indices = new Set<number>([pickedVariantIndex, ...ratingByVariant.keys()]);
  for (const idx of indices) {
    const picked = idx === pickedVariantIndex;
    const dims = VARIANT_TASTE_DIMENSIONS[idx] ?? [];
    const score = ratingByVariant.get(idx);

    if (picked) {
      for (const d of dims) {
        try {
          await applyTaste({ tenantId: tenantCtx.tenantId, userId: tenantCtx.userId, dimension: d.dimension, value: d.value, outcome: 'approved', weight: 2 });
          result.tasteSignals++;
        } catch (err) {
          console.warn('[variant-pick-finalize] applyTasteSignal (pick) failed — continuing', err);
        }
      }
    } else if (score !== undefined) {
      const outcome = ratingOutcome(score);
      if (outcome) {
        for (const d of dims) {
          try {
            await applyTaste({ tenantId: tenantCtx.tenantId, userId: tenantCtx.userId, dimension: d.dimension, value: d.value, outcome, weight: ratingWeight(score) });
            result.tasteSignals++;
          } catch (err) {
            console.warn('[variant-pick-finalize] applyTasteSignal (rating) failed — continuing', err);
          }
        }
      }
    }

    if (picked || ratingByVariant.has(idx)) {
      const variantJobId = batch.job_ids[idx] ?? batch.batch_id;
      try {
        scheduleHoncho({
          tenantCtx,
          memoryActorUserId: tenantCtx.userId,
          jobId: batch.batch_id, // → session-onboarding-<batch_id>
          slotIndex: batch.slot_index,
          variantId: picked && input.pickedCreativeId ? input.pickedCreativeId : variantJobId,
          rating: ratingByVariant.has(idx) ? String(ratingByVariant.get(idx)) : picked ? 'picked' : '',
          editOps: (editsByVariant.get(idx) ?? []).join(',') || null,
          picked,
          eventDateYmd: ymd,
          explicitUserIntent: true,
        });
        result.honchoScheduled++;
      } catch (err) {
        console.warn('[variant-pick-finalize] scheduleOnboardingVariantTasteSignalHoncho failed — continuing', err);
      }
    }
  }

  // --- 2. Resume the chosen variant's publish ------------------------------
  // Variant jobs are HELD at their publish checkpoint until picked. recordVariantPick
  // set variant_pick_finalized on the chosen job; approve its publish checkpoint so
  // the chosen post actually publishes. (If the checkpoint hasn't emitted yet, the
  // global auto-approve promotes it once it does.)
  try {
    const chosenJobId = batch.job_ids[pickedVariantIndex];
    if (chosenJobId) {
      const chosenDoc = await loadJobDoc(chosenJobId);
      const cp = chosenDoc?.approvals?.current;
      if (chosenDoc && cp && cp.stage === 'publish' && cp.approval_id && chosenDoc.tenant_id === tenantCtx.tenantId) {
        await approveJob(
          {
            jobId: chosenJobId,
            tenantId: tenantCtx.tenantId,
            approvedBy: 'ai-orchestrator-variant-pick',
            approvalId: cp.approval_id,
            approvedStages: ['publish'],
            publishConfig: cp.publish_config ?? undefined,
          },
          chosenDoc,
        );
      }
    }
  } catch (err) {
    console.warn('[variant-pick-finalize] resume chosen-job publish failed — continuing', err);
  }

  // --- 3. Phase B: posts #2-7 anchored to the chosen variant's direction ----
  try {
    const chosenJobId = batch.job_ids[pickedVariantIndex];
    const basePayload = chosenJobId ? extractBasePayload(await loadJobDoc(chosenJobId)) : null;
    if (basePayload) {
      const anchor = VARIANT_LENSES[pickedVariantIndex] ?? VARIANT_LENSES[0];
      const res = await startJob({
        tenantId: tenantCtx.tenantId,
        jobType: 'weekly_social_content',
        createdBy: tenantCtx.userId,
        payload: {
          ...basePayload,
          // The remaining 6 posts of week 1, anchored to the picked direction.
          staticPostCount: 6,
          imageCreativeCount: 6,
          campaignStyleAnchor: anchor,
          creativeBriefs: [`Match this first-post visual direction across the week: ${anchor}`],
        },
      });
      result.phaseBJobId = res.jobId;
    }
  } catch (err) {
    console.warn('[variant-pick-finalize] Phase-B anchored generation failed — continuing', err);
  }

  return result;
}
