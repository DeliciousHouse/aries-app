/**
 * Runtime edit-state for inline copy edits on review items.
 *
 * T19 — single-writer, last-write-wins. No optimistic concurrency, no CRDT.
 * Edits override `currentVersion.headline` / `currentVersion.supportingText`
 * on the runtime review item. Previous version is archived in-place so the
 * UI can surface "previous draft" diffs without a separate history table.
 *
 * Storage: ${DATA_ROOT}/generated/draft/marketing-review-edits/${jobId}.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';

export type ReviewItemEdit = {
  /** Edited headline override. `null` means cleared (revert to source). */
  headline: string | null;
  /** Edited supporting text / caption body override. `null` clears. */
  supportingText: string | null;
  /** ISO timestamp of last write. */
  updatedAt: string;
  /** Author display name from tenant context (best-effort, non-authoritative). */
  editedBy: string | null;
  /** Snapshot of the previous override (one level deep) for the UI. Null on
   * first edit so the source-of-truth view is rebuilt from the runtime doc. */
  previous: { headline: string | null; supportingText: string | null } | null;
};

export type ReviewEditStateFile = {
  schema_name: 'marketing_review_edit_state';
  schema_version: '1.0.0';
  job_id: string;
  tenant_id: string;
  /** Map keyed by reviewId — same identifier the runtime queue exposes. */
  items: Record<string, ReviewItemEdit>;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function reviewEditStatePath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-review-edits', `${jobId}.json`);
}

function emptyState(jobId: string, tenantId: string): ReviewEditStateFile {
  return {
    schema_name: 'marketing_review_edit_state',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: tenantId,
    items: {},
    updated_at: nowIso(),
  };
}

export function loadReviewEditState(jobId: string, tenantId: string): ReviewEditStateFile {
  const filePath = reviewEditStatePath(jobId);
  if (!existsSync(filePath)) {
    return emptyState(jobId, tenantId);
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ReviewEditStateFile;
    if (parsed && parsed.job_id === jobId && parsed.tenant_id === tenantId && parsed.items) {
      return parsed;
    }
  } catch {
    // Fall through to empty state — corrupt file should not block writes.
  }
  return emptyState(jobId, tenantId);
}

function saveReviewEditState(state: ReviewEditStateFile): string {
  const filePath = reviewEditStatePath(state.job_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  state.updated_at = nowIso();
  writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

export type RecordReviewEditInput = {
  jobId: string;
  tenantId: string;
  reviewId: string;
  /** When provided, replaces previous override. `undefined` leaves it alone. */
  headline?: string | null;
  /** When provided, replaces previous override. `undefined` leaves it alone. */
  supportingText?: string | null;
  editedBy?: string | null;
};

/**
 * Record an inline copy edit. Last-write-wins; previous override is archived
 * in `previous` so the UI can show before/after on the next read without a
 * version-history surface. Returns the persisted edit.
 */
export function recordReviewItemEdit(input: RecordReviewEditInput): ReviewItemEdit {
  const state = loadReviewEditState(input.jobId, input.tenantId);
  const existing = state.items[input.reviewId] ?? null;

  const nextHeadline =
    input.headline === undefined ? existing?.headline ?? null : input.headline;
  const nextSupporting =
    input.supportingText === undefined ? existing?.supportingText ?? null : input.supportingText;

  const edit: ReviewItemEdit = {
    headline: nextHeadline,
    supportingText: nextSupporting,
    updatedAt: nowIso(),
    editedBy: input.editedBy ?? null,
    previous: existing
      ? { headline: existing.headline, supportingText: existing.supportingText }
      : null,
  };

  state.items[input.reviewId] = edit;
  saveReviewEditState(state);
  return edit;
}

export function getReviewItemEdit(
  jobId: string,
  tenantId: string,
  reviewId: string,
): ReviewItemEdit | null {
  const state = loadReviewEditState(jobId, tenantId);
  return state.items[reviewId] ?? null;
}
