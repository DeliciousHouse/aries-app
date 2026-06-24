import path from 'node:path';

import { pool } from '@/lib/db';

import {
  getMarketingExecutionPort,
  type MarketingExecutionPort,
  type MarketingExecutionPortEnv,
  type RegenerateCreativeContext,
} from './execution-port';
import { isImageEditEnabled } from './image-edit-env';
import { recordStyleVibeTasteSignal } from './review-edit-taste';
import {
  loadSocialContentJobRuntime,
  type SocialContentJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';

export type RegenerateCreativeInput = {
  jobId: string;
  creativeId: string;
  tenantId: string;
  sourceRunId?: string | null;
  port?: MarketingExecutionPort;
  env?: MarketingExecutionPortEnv;
};

export type RegenerateCreativeResult =
  | {
      kind: 'submitted';
      ariesRunId: string;
      hermesRunId: string | null;
      sourceRunId: string;
      sourceCreativeId: string;
      jobId: string;
      tenantId: string;
    }
  | { kind: 'job_not_found' }
  | { kind: 'tenant_mismatch' }
  | { kind: 'invalid_input'; code: 'missing_creative_id' | 'missing_source_run_id'; message: string }
  | { kind: 'failed'; code: string; message: string };

function nonEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function inferSourceRunIdFromDoc(doc: SocialContentJobRuntimeDocument): string {
  const order: MarketingStage[] = ['publish', 'production', 'strategy', 'research'];
  for (const stage of order) {
    const runId = nonEmpty(doc.stages?.[stage]?.run_id);
    if (runId) return runId;
  }
  return '';
}

/** Every run_id Aries knows belongs to this job (one per completed stage). */
function collectDocStageRunIds(doc: SocialContentJobRuntimeDocument): string[] {
  const order: MarketingStage[] = ['publish', 'production', 'strategy', 'research'];
  const ids: string[] = [];
  for (const stage of order) {
    const runId = nonEmpty(doc.stages?.[stage]?.run_id);
    if (runId) ids.push(runId);
  }
  return ids;
}

function defaultPortFactory(env?: MarketingExecutionPortEnv): MarketingExecutionPort {
  return getMarketingExecutionPort(env);
}

export async function regenerateCreativeAsNewRun(
  input: RegenerateCreativeInput,
): Promise<RegenerateCreativeResult> {
  const creativeId = nonEmpty(input.creativeId);
  if (!creativeId) {
    return {
      kind: 'invalid_input',
      code: 'missing_creative_id',
      message: 'creativeId is required.',
    };
  }

  const doc = await loadSocialContentJobRuntime(input.jobId);
  if (!doc) {
    return { kind: 'job_not_found' };
  }
  if (doc.tenant_id !== input.tenantId) {
    return { kind: 'tenant_mismatch' };
  }

  const sourceRunId = nonEmpty(input.sourceRunId) || inferSourceRunIdFromDoc(doc);
  if (!sourceRunId) {
    return {
      kind: 'invalid_input',
      code: 'missing_source_run_id',
      message: 'source_run_id is required to regenerate a creative.',
    };
  }

  const regenerateCreative: RegenerateCreativeContext = {
    source_run_id: sourceRunId,
    source_creative_id: creativeId,
  };

  const port = input.port ?? defaultPortFactory(input.env);

  const result = await port.runPipeline({
    jobId: input.jobId,
    doc,
    argsJson: JSON.stringify({
      job_id: input.jobId,
      regenerate_creative: regenerateCreative,
    }),
    regenerateCreative,
  });

  if (result.kind === 'submitted') {
    if (result.ariesRunId === sourceRunId) {
      return {
        kind: 'failed',
        code: 'regenerate_run_collision',
        message: 'Regenerate produced the same aries_run_id as the source run.',
      };
    }
    // PR2 Phase 3: regenerating a creative is a structural rejection of the
    // current one — teach tenant taste on the brand's visual-style lens.
    // Best-effort + flag-gated (no-op when OFF); never blocks the regenerate.
    await recordStyleVibeTasteSignal({
      tenantId: input.tenantId,
      styleVibe: doc.brand_kit?.style_vibe ?? null,
      outcome: 'rejected',
    });
    return {
      kind: 'submitted',
      ariesRunId: result.ariesRunId,
      hermesRunId: result.hermesRunId ?? null,
      sourceRunId,
      sourceCreativeId: creativeId,
      jobId: input.jobId,
      tenantId: input.tenantId,
    };
  }

  const error = result.output.error;
  return {
    kind: 'failed',
    code: error?.code ?? 'hermes_regenerate_run_failed',
    message: error?.message ?? 'Hermes did not return a submitted regenerate run.',
  };
}

// ---------------------------------------------------------------------------
// Image edit (image-to-image) — ARIES_IMAGE_EDIT_ENABLED
// ---------------------------------------------------------------------------

const MAX_EDIT_INSTRUCTION_LEN = 2000;

/**
 * Resolves the source creative's image basename in the Hermes content-generator
 * cache so the profile can edit that exact file. Only `runtime_asset` rows live
 * in that cache (keyed by basename via `storage_key`); `ingested_asset` rows
 * (framed logos / operator uploads) live under DATA_ROOT and cannot be edited
 * by basename — they resolve to null and the run falls back to locating the
 * source via source_run_id/source_creative_id. Fail-open: any DB/parse error
 * returns null so an edit is never blocked.
 *
 * `creativeId` may be the row UUID (`id`) or the Hermes key (`source_asset_id`);
 * both are matched. Single indexed-ish lookup per user-initiated edit (not a
 * fan-out hot path — guardrail #1 does not apply).
 */
export type SourceImageResolver = (args: {
  tenantId: string;
  jobId: string;
  creativeId: string;
}) => Promise<string | null>;

interface BasenameDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<{ storage_key?: string | null }> }>;
}

export async function resolveRuntimeSourceImageBasename(
  args: { tenantId: string; jobId: string; creativeId: string },
  db: BasenameDb = pool,
): Promise<string | null> {
  const tenantIdInt = Number(args.tenantId);
  if (!Number.isFinite(tenantIdInt) || tenantIdInt <= 0) {
    return null;
  }
  const creativeId = nonEmpty(args.creativeId);
  const jobId = nonEmpty(args.jobId);
  if (!creativeId || !jobId) {
    return null;
  }
  try {
    // Scoped to (tenant, job): never resolves a basename from another tenant
    // (no cross-tenant leak) nor from a different job of the same tenant
    // (source_asset_id is not unique across jobs).
    const { rows } = await db.query(
      `SELECT storage_key
         FROM creative_assets
        WHERE tenant_id = $1
          AND source_job_id = $3
          AND storage_kind = 'runtime_asset'
          AND (id::text = $2 OR source_asset_id = $2)
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantIdInt, creativeId, jobId],
    );
    const storageKey = rows[0]?.storage_key;
    if (!storageKey) {
      return null;
    }
    const basename = path.basename(storageKey);
    if (!basename || basename.includes('..') || basename.includes('/') || basename.includes('\\')) {
      return null;
    }
    return basename;
  } catch (error) {
    // Fail-open: an unresolvable source still submits; Hermes falls back to
    // locating the source via source_run_id + source_creative_id. Log so a
    // systematic resolution failure (e.g. pool contention, a query bug) is
    // observable rather than silently masquerading as "no runtime_asset row".
    console.warn('[image-edit] source-image basename resolution failed; falling back to id-based source', {
      jobId: args.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export type EditCreativeInput = {
  jobId: string;
  creativeId: string;
  tenantId: string;
  editInstruction: string;
  sourceRunId?: string | null;
  port?: MarketingExecutionPort;
  env?: MarketingExecutionPortEnv;
  /** Override the flag read (tests). Defaults to ARIES_IMAGE_EDIT_ENABLED. */
  enabled?: boolean;
  /** Override the source-image resolver (tests). */
  resolveSourceImage?: SourceImageResolver;
};

export type EditCreativeResult =
  | {
      kind: 'submitted';
      ariesRunId: string;
      hermesRunId: string | null;
      sourceRunId: string;
      sourceCreativeId: string;
      jobId: string;
      tenantId: string;
      editInstruction: string;
      sourceImageBasename: string | null;
    }
  | { kind: 'disabled' }
  | { kind: 'job_not_found' }
  | { kind: 'tenant_mismatch' }
  | {
      kind: 'invalid_input';
      code: 'missing_creative_id' | 'missing_source_run_id' | 'missing_edit_instruction';
      message: string;
    }
  | { kind: 'failed'; code: string; message: string };

/**
 * Submits a new aries_run scoped to an IMAGE EDIT of an existing creative.
 * Reuses the regenerate submission path (same per-stage profile pipeline,
 * scoped by `regenerate_creative`) but carries an `edit_instruction` + the
 * source image basename so the Hermes content-generator profile edits the
 * existing image (image-to-image) instead of generating from scratch. The
 * original creative_assets row is preserved; the edited image lands as a new
 * row, exactly like regenerate.
 */
export async function editCreativeAsImageEdit(
  input: EditCreativeInput,
): Promise<EditCreativeResult> {
  const enabled = input.enabled ?? isImageEditEnabled(input.env);
  if (!enabled) {
    // Invisible when OFF — the route 404s, no DB, no gateway.
    return { kind: 'disabled' };
  }

  const creativeId = nonEmpty(input.creativeId);
  if (!creativeId) {
    return {
      kind: 'invalid_input',
      code: 'missing_creative_id',
      message: 'creativeId is required.',
    };
  }

  const editInstruction = nonEmpty(input.editInstruction).slice(0, MAX_EDIT_INSTRUCTION_LEN);
  if (!editInstruction) {
    return {
      kind: 'invalid_input',
      code: 'missing_edit_instruction',
      message: 'An edit instruction is required to edit a creative.',
    };
  }

  const doc = await loadSocialContentJobRuntime(input.jobId);
  if (!doc) {
    return { kind: 'job_not_found' };
  }
  if (doc.tenant_id !== input.tenantId) {
    return { kind: 'tenant_mismatch' };
  }

  // Defense-in-depth: an explicit sourceRunId arrives from the request body, so
  // only trust it when it actually belongs to THIS job's stages — otherwise an
  // operator could steer Hermes' id-based source lookup (the fallback used when
  // the basename is unresolvable) toward a run id outside this job. When it does
  // not belong, fall back to inference rather than rejecting: the UI never sends
  // sourceRunId, so this is transparent to the real flow. The tenant-scoped
  // basename resolver remains the primary, authoritative source locator.
  const explicitRunId = nonEmpty(input.sourceRunId);
  const trustedExplicitRunId =
    explicitRunId && collectDocStageRunIds(doc).includes(explicitRunId) ? explicitRunId : '';
  const sourceRunId = trustedExplicitRunId || inferSourceRunIdFromDoc(doc);
  if (!sourceRunId) {
    return {
      kind: 'invalid_input',
      code: 'missing_source_run_id',
      message: 'source_run_id is required to edit a creative.',
    };
  }

  const resolveSourceImage = input.resolveSourceImage ?? resolveRuntimeSourceImageBasename;
  // Fail-open structurally: a custom/future resolver that throws must not 500
  // the edit — Hermes can still fall back to source_run_id + source_creative_id.
  const sourceImageBasename = await resolveSourceImage({
    tenantId: input.tenantId,
    jobId: input.jobId,
    creativeId,
  }).catch(() => null);

  const regenerateCreative: RegenerateCreativeContext = {
    source_run_id: sourceRunId,
    source_creative_id: creativeId,
    edit_instruction: editInstruction,
    ...(sourceImageBasename ? { source_image_basename: sourceImageBasename } : {}),
  };

  const port = input.port ?? defaultPortFactory(input.env);

  const result = await port.runPipeline({
    jobId: input.jobId,
    doc,
    argsJson: JSON.stringify({
      job_id: input.jobId,
      regenerate_creative: regenerateCreative,
    }),
    regenerateCreative,
  });

  if (result.kind === 'submitted') {
    if (result.ariesRunId === sourceRunId) {
      return {
        kind: 'failed',
        code: 'edit_run_collision',
        message: 'Edit produced the same aries_run_id as the source run.',
      };
    }
    // An edit is a structural change to the current creative — teach tenant
    // taste on the brand's visual-style lens (best-effort + flag-gated; no-op
    // when OFF; never blocks the edit), mirroring regenerate.
    await recordStyleVibeTasteSignal({
      tenantId: input.tenantId,
      styleVibe: doc.brand_kit?.style_vibe ?? null,
      outcome: 'rejected',
    });
    return {
      kind: 'submitted',
      ariesRunId: result.ariesRunId,
      hermesRunId: result.hermesRunId ?? null,
      sourceRunId,
      sourceCreativeId: creativeId,
      jobId: input.jobId,
      tenantId: input.tenantId,
      editInstruction,
      sourceImageBasename: sourceImageBasename ?? null,
    };
  }

  const error = result.output.error;
  return {
    kind: 'failed',
    code: error?.code ?? 'hermes_edit_run_failed',
    message: error?.message ?? 'Hermes did not return a submitted edit run.',
  };
}
