/**
 * Onboarding first-post variant board — fan-out + board read.
 *
 * startFirstPostVariantBatch fans out N (MVP = 3) single-post weekly jobs for
 * slot 0, each with a variant-distinct creative brief and the shared
 * variant_batch_id/variant_index stamped into the job payload (which lands in
 * doc.inputs.request, where ingest-production-assets reads it back — the Hermes
 * callback carries no callback_context). It reuses the proven weekly pipeline
 * with a per-job scope override (staticPostCount/imageCreativeCount = 1), so
 * there is no Hermes-contract change and no new submission machinery.
 *
 * getVariantBoard reads the resulting creative_assets back by variant_batch_id
 * and reports board readiness at READ time (all variants present, or picked, or
 * a timeout auto-pick). Nothing here is wired into the live onboarding flow yet
 * (Phase 3 does the wiring + UI), so it is inert until then regardless of flag.
 */
import pool from '@/lib/db';
import {
  startSocialContentJob,
  type StartSocialContentJobRequest,
  type StartSocialContentJobResponse,
} from './orchestrator';
import {
  loadSocialContentJobRuntime,
  saveSocialContentJobRuntime,
  type SocialContentJobRuntimeDocument,
} from './runtime-state';
import {
  claimVariantPick,
  loadVariantBatch,
  makeVariantBatchId,
  saveVariantBatch,
  VARIANT_BATCH_SCHEMA_NAME,
  VARIANT_BATCH_SCHEMA_VERSION,
  type VariantBatchRecord,
} from './variant-batch-store';

type Queryable = Pick<typeof pool, 'query'>;

/** Number of competing variants per slot (MVP = 3, mirroring gstack's board). */
export const VARIANT_COUNT = 3;

const DEFAULT_VARIANT_BOARD_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** How long the board may sit unpicked before the abandon/auto-pick fallback. */
export function variantBoardTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.ARIES_ONBOARDING_VARIANT_BOARD_TIMEOUT_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VARIANT_BOARD_TIMEOUT_MS;
}

// Three deliberately divergent visual lenses so the variants genuinely differ
// (the gstack anti-convergence idea) instead of producing near-duplicates.
export const VARIANT_LENSES: readonly string[] = [
  'Bold, high-contrast, minimalist: one strong focal subject, generous negative space, confident and premium.',
  'Warm, editorial, lifestyle: natural light, candid human framing, inviting and authentic.',
  'Playful, vibrant, graphic: saturated color, energetic composition, modern and fun.',
];

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Build N variant-distinct creative briefs from the onboarding payload: a shared
 * base (goal · offer · style · audience) plus a per-variant visual lens.
 */
export function buildVariantBriefs(
  payload: Record<string, unknown>,
  lenses: readonly string[] = VARIANT_LENSES,
): string[] {
  const base = [
    asString(payload.primaryGoal) || asString(payload.goal),
    asString(payload.offer),
    asString(payload.styleVibe),
    asString(payload.audience),
  ]
    .filter((s) => s.length > 0)
    .join(' · ');
  const baseBrief = base || 'On-brand first social post.';
  return lenses.map((lens) => `${baseBrief} — Visual direction: ${lens}`);
}

export type StartFirstPostVariantBatchInput = {
  tenantId: string;
  createdBy: string | null;
  payload: Record<string, unknown>;
  /** Injectable for tests; defaults to the real orchestrator entry point. */
  startJob?: (req: StartSocialContentJobRequest) => Promise<StartSocialContentJobResponse>;
  /** Called with the batch id right after the (empty) batch record is persisted
   * and BEFORE any job is submitted — so the caller can durably point its draft
   * at the batch first. A later submit failure then leaves a recoverable pointer
   * instead of orphaning live jobs + re-running the fan-out on revisit. */
  onBatchCreated?: (batchId: string) => Promise<void> | void;
};

export type StartFirstPostVariantBatchResult = {
  variantBatchId: string;
  jobIds: string[];
  slotIndex: number;
};

/**
 * Fan out VARIANT_COUNT single-post weekly jobs for slot 0 and persist the batch
 * record. Returns the batch id + the per-variant job ids. Submissions are
 * sequential (NOT Promise.all) per guardrail #1 — each returns quickly because
 * submitRawRun's poll-bridge runs in the background, so the generations still
 * proceed concurrently on Hermes.
 */
export async function startFirstPostVariantBatch(
  input: StartFirstPostVariantBatchInput,
): Promise<StartFirstPostVariantBatchResult> {
  const startJob = input.startJob ?? startSocialContentJob;
  const briefs = buildVariantBriefs(input.payload);
  if (briefs.length < VARIANT_COUNT) {
    // Guard against VARIANT_COUNT outrunning VARIANT_LENSES (a future count bump
    // without more lenses) — fail loud instead of submitting creativeBriefs:[undefined],
    // which would silently fall back to the generic brief (non-distinct variants).
    throw new Error(`[onboarding-variant-batch] need >= ${VARIANT_COUNT} briefs, got ${briefs.length}`);
  }
  const batchId = makeVariantBatchId();
  const slotIndex = 0;

  // Persist the batch record up front and re-save after each submit. A throw
  // mid-fan-out (startSocialContentJob can throw on input validation or a live
  // brand-kit fetch BEFORE its internal try/catch) would otherwise orphan jobs
  // already submitted to Hermes with no record — the board could never render
  // and the timeout/auto-pick path (which needs the record) could never resolve
  // the draft. Saving incrementally keeps every live job recoverable
  // (resumability rule). The error still propagates so the caller can fall back.
  const record: VariantBatchRecord = {
    schema_name: VARIANT_BATCH_SCHEMA_NAME,
    schema_version: VARIANT_BATCH_SCHEMA_VERSION,
    batch_id: batchId,
    tenant_id: input.tenantId,
    user_id: input.createdBy,
    slot_index: slotIndex,
    job_ids: [],
    created_at: new Date().toISOString(),
    picked_variant_index: null,
    picked_creative_id: null,
    picked_at: null,
    abandoned_at: null,
  };
  saveVariantBatch(record);
  // Let the caller pin its draft to this batch BEFORE any job submits, so a
  // submit failure is recoverable (the board renders what landed + times out)
  // rather than orphaning live jobs and re-fanning on revisit.
  if (input.onBatchCreated) {
    await input.onBatchCreated(batchId);
  }

  for (let i = 0; i < VARIANT_COUNT; i++) {
    const res = await startJob({
      tenantId: input.tenantId,
      jobType: 'weekly_social_content',
      createdBy: input.createdBy,
      payload: {
        ...input.payload,
        // Scope override: this job produces exactly one post (one image) driven
        // by the variant-distinct brief. These ride doc.inputs.request.
        staticPostCount: 1,
        imageCreativeCount: 1,
        storyCount: 0,
        videoRenderCount: 0,
        creativeBriefs: [briefs[i]],
        // Variant grouping tags — read back at ingest time off doc.inputs.request.
        variant_batch_id: batchId,
        variant_index: i,
        slot_index: slotIndex,
      },
    });
    record.job_ids.push(res.jobId);
    saveVariantBatch(record);
  }

  return { variantBatchId: batchId, jobIds: [...record.job_ids], slotIndex };
}

export type VariantCard = {
  variant_index: number;
  creative_id: string;
  served_asset_ref: string | null;
  /** The variant's generation job (batch.job_ids[variant_index]) — the board's
   * edit actions (regenerate / more-like-this / freeform) scope to this job. */
  job_id: string | null;
};

export type VariantBoardView = {
  batch_id: string;
  slot_index: number;
  /** True when all variants have landed, or the board was picked/abandoned. */
  board_ready: boolean;
  picked_variant_index: number | null;
  picked_creative_id: string | null;
  abandoned: boolean;
  cards: VariantCard[];
};

type VariantAssetRow = {
  variant_index: number;
  creative_id: string;
  served_asset_ref: string | null;
};

/**
 * PURE board projection: given the batch record + its ingested assets + the
 * clock, decide the cards, readiness, and whether a stale unpicked board should
 * auto-abandon (timeout auto-pick of variant 0). No I/O; unit-tested directly.
 */
export function summarizeVariantBoard(
  batch: VariantBatchRecord,
  assets: VariantAssetRow[],
  nowMs: number,
  timeoutMs: number,
): { view: VariantBoardView; shouldAbandon: boolean } {
  const byIndex = new Map<number, VariantCard>();
  for (const a of assets) {
    if (!Number.isInteger(a.variant_index) || a.variant_index < 0) continue;
    // First row per index wins. getVariantBoard's SELECT orders created_at DESC,
    // so that is the LATEST creative — an edit (regenerate / more-like-this /
    // freeform) produces a newer creative for the same (batch, index) and the
    // card correctly swaps to it on the next poll.
    if (!byIndex.has(a.variant_index)) {
      byIndex.set(a.variant_index, {
        variant_index: a.variant_index,
        creative_id: a.creative_id,
        served_asset_ref: a.served_asset_ref,
        job_id: batch.job_ids[a.variant_index] ?? null,
      });
    }
  }
  const cards = [...byIndex.values()].sort((x, y) => x.variant_index - y.variant_index);

  const allPresent = cards.length >= VARIANT_COUNT;
  const picked = batch.picked_variant_index;
  const alreadyAbandoned = batch.abandoned_at !== null;

  // Fail OPEN on a corrupt/missing created_at: treat it as maximally stale so a
  // bad on-disk record resolves via timeout instead of hanging forever (the
  // previous Number.isFinite guard failed CLOSED → permanent hang).
  const createdMs = Date.parse(batch.created_at);
  const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : Number.POSITIVE_INFINITY;
  const shouldAbandon = !alreadyAbandoned && picked === null && !allPresent && ageMs >= timeoutMs;

  // Timeout auto-pick: the LOWEST variant_index that actually landed (cards is
  // sorted ascending), never a hardcoded 0 that might have no creative. If
  // nothing landed, abandon WITHOUT a pick so the resume path can fall back to a
  // plain post instead of finalizing an empty slot.
  const lowestLanded = cards.length > 0 ? cards[0] : null;
  const resolvedPick = shouldAbandon ? (lowestLanded ? lowestLanded.variant_index : null) : picked;
  const resolvedCreativeId = shouldAbandon
    ? lowestLanded
      ? lowestLanded.creative_id
      : null
    : batch.picked_creative_id;

  const abandoned = alreadyAbandoned || shouldAbandon;
  const board_ready = allPresent || abandoned || resolvedPick !== null;

  return {
    view: {
      batch_id: batch.batch_id,
      slot_index: batch.slot_index,
      board_ready,
      picked_variant_index: resolvedPick,
      picked_creative_id: resolvedCreativeId,
      abandoned,
      cards,
    },
    shouldAbandon,
  };
}

const SELECT_VARIANT_ASSETS_SQL = `
  SELECT variant_index, id::text AS creative_id, served_asset_ref
    FROM creative_assets
   WHERE tenant_id = $1 AND variant_batch_id = $2
   ORDER BY variant_index ASC, created_at DESC, id DESC`;

/**
 * Load the variant board for a (batch, tenant): reads the ingested creative_assets
 * grouped by variant_batch_id and reports readiness. If the board is stale and
 * unpicked past the timeout, lazily persists a timeout auto-pick (variant 0) so
 * the draft never hangs. Returns null for an unknown batch or tenant mismatch.
 */
export async function getVariantBoard(args: {
  batchId: string;
  tenantId: string;
  client?: Queryable;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<VariantBoardView | null> {
  const batch = await loadVariantBatch(args.batchId);
  if (!batch) return null;
  if (batch.tenant_id !== args.tenantId) return null; // tenant scope guard

  const tid = Number.parseInt(batch.tenant_id, 10);
  if (!Number.isFinite(tid) || tid <= 0) return null;

  const client = args.client ?? pool;
  const r = await client.query<VariantAssetRow>(SELECT_VARIANT_ASSETS_SQL, [tid, batch.batch_id]);
  const assets = r.rows ?? [];

  const nowMs = (args.now ?? new Date()).getTime();
  const { view, shouldAbandon } = summarizeVariantBoard(batch, assets, nowMs, variantBoardTimeoutMs(args.env));

  if (shouldAbandon) {
    // Lazy timeout auto-pick: never hang in materializing if the user left.
    // Persist the resolved pick (lowest landed variant, or null when nothing
    // landed) + its creative id, computed by summarizeVariantBoard.
    const abandonedIso = new Date(nowMs).toISOString();
    batch.abandoned_at = abandonedIso;
    batch.picked_variant_index = view.picked_variant_index;
    batch.picked_creative_id = view.picked_creative_id;
    batch.picked_at = view.picked_variant_index !== null ? batch.picked_at ?? abandonedIso : batch.picked_at;
    saveVariantBatch(batch);
  }

  return view;
}

export type RecordVariantPickResult =
  | { kind: 'picked'; batchId: string; pickedVariantIndex: number; finalizedJobId: string }
  | { kind: 'not_found' }
  | { kind: 'tenant_mismatch' }
  | { kind: 'invalid_variant' }
  | { kind: 'already_resolved'; pickedVariantIndex: number | null };

/**
 * Record an explicit user pick on a variant board: mark the chosen variant on
 * the batch record and RELEASE the chosen job to publish by stamping
 * variant_pick_finalized on its doc (the autoSchedule guard holds every variant
 * job until this flag is set, so the unchosen ones stay held). Idempotent-safe:
 * a batch already picked/abandoned returns 'already_resolved' without mutating.
 *
 * The taste write (Aries DB + Honcho), the Phase-B anchored generation of posts
 * #2-7, and the actual publish-stage resume of the chosen job are Phase 4 and
 * hang off the 'picked' result; this function owns only the pick state transition.
 */
export async function recordVariantPick(input: {
  batchId: string;
  tenantId: string;
  selectedVariantIndex: number;
  selectedCreativeId?: string | null;
  loadJobDoc?: (jobId: string) => Promise<SocialContentJobRuntimeDocument | null>;
  saveJobDoc?: (jobId: string, doc: SocialContentJobRuntimeDocument) => string;
}): Promise<RecordVariantPickResult> {
  const loadJobDoc = input.loadJobDoc ?? loadSocialContentJobRuntime;
  const saveJobDoc = input.saveJobDoc ?? saveSocialContentJobRuntime;

  const batch = await loadVariantBatch(input.batchId);
  if (!batch) return { kind: 'not_found' };
  if (batch.tenant_id !== input.tenantId) return { kind: 'tenant_mismatch' };
  if (batch.picked_variant_index !== null || batch.abandoned_at !== null) {
    return { kind: 'already_resolved', pickedVariantIndex: batch.picked_variant_index };
  }

  const idx = input.selectedVariantIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= batch.job_ids.length) {
    return { kind: 'invalid_variant' };
  }

  // Atomically claim the pick so two concurrent picks don't both finalize
  // (duplicate Phase-B job + double taste). The loser is treated as resolved.
  if (!claimVariantPick(input.batchId)) {
    const fresh = await loadVariantBatch(input.batchId);
    return { kind: 'already_resolved', pickedVariantIndex: fresh?.picked_variant_index ?? null };
  }

  const chosenJobId = batch.job_ids[idx];
  // Release the chosen job to publish; tenant-checked so a tampered batch can't
  // flip a foreign job's doc.
  const doc = await loadJobDoc(chosenJobId);
  if (doc && doc.tenant_id === batch.tenant_id) {
    const request =
      doc.inputs?.request && typeof doc.inputs.request === 'object'
        ? (doc.inputs.request as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    request.variant_pick_finalized = true;
    doc.inputs.request = request;
    saveJobDoc(chosenJobId, doc);
  }

  batch.picked_variant_index = idx;
  batch.picked_creative_id = input.selectedCreativeId ?? batch.picked_creative_id;
  batch.picked_at = new Date().toISOString();
  saveVariantBatch(batch);

  return { kind: 'picked', batchId: batch.batch_id, pickedVariantIndex: idx, finalizedJobId: chosenJobId };
}
