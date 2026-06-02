/**
 * Persistence for an onboarding first-post variant batch — the record that ties
 * the N (MVP = 3) fanned-out variant jobs together so the board can render them
 * as a group and the pick/timeout path can resolve them.
 *
 * Stored as a small JSON runtime doc under
 * DATA_ROOT/generated/draft/variant-batches/<batchId>.json, mirroring the
 * marketing job runtime docs (backend/marketing/runtime-state.ts). The actual
 * creative images live in the creative_assets table, grouped by variant_batch_id;
 * this record only holds the batch's identity, the per-variant job ids, and the
 * pick/abandon resolution.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';

export const VARIANT_BATCH_SCHEMA_NAME = 'onboarding_variant_batch';
export const VARIANT_BATCH_SCHEMA_VERSION = '1.0.0';

export type VariantBatchRecord = {
  schema_name: typeof VARIANT_BATCH_SCHEMA_NAME;
  schema_version: typeof VARIANT_BATCH_SCHEMA_VERSION;
  /** vbatch_<uuid> — also the creative_assets.variant_batch_id grouping key. */
  batch_id: string;
  tenant_id: string;
  user_id: string | null;
  /** Which post slot this board is for (MVP = 0, the first post). */
  slot_index: number;
  /** One job id per variant, index-aligned to variant_index (0..n-1). */
  job_ids: string[];
  created_at: string;
  /** Set on an explicit user pick (Phase 3) or a timeout auto-pick (variant 0). */
  picked_variant_index: number | null;
  picked_creative_id: string | null;
  picked_at: string | null;
  /** Set by the timeout/abandon path so a draft never hangs waiting for a pick. */
  abandoned_at: string | null;
};

export function makeVariantBatchId(): string {
  return `vbatch_${randomUUID()}`;
}

export function variantBatchPath(batchId: string): string {
  return resolveDataPath('generated', 'draft', 'variant-batches', `${batchId}.json`);
}

export async function loadVariantBatch(batchId: string): Promise<VariantBatchRecord | null> {
  const id = batchId?.trim();
  if (!id) return null;
  try {
    const raw = await readFile(variantBatchPath(id), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.schema_name !== VARIANT_BATCH_SCHEMA_NAME) return null;
    if (typeof parsed.batch_id !== 'string' || !parsed.batch_id) return null;
    if (typeof parsed.tenant_id !== 'string' || !parsed.tenant_id) return null;
    if (!Array.isArray(parsed.job_ids)) return null;
    return parsed as VariantBatchRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

export function saveVariantBatch(record: VariantBatchRecord): string {
  const filePath = variantBatchPath(record.batch_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

/**
 * Atomically claim the single pick for a batch. recordVariantPick's load-check-
 * save is not race-safe on its own (concurrent picks — double-click, two tabs —
 * can both observe picked_variant_index===null and both finalize, duplicating
 * the Phase-B job + taste). An exclusive-create sentinel (flag 'wx') serializes
 * them: exactly one writer wins; the rest get false and are treated as already
 * resolved. The sentinel is never removed (a batch is picked at most once).
 */
export function claimVariantPick(batchId: string): boolean {
  const lockPath = `${variantBatchPath(batchId)}.pick.lock`;
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, new Date().toISOString(), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}
