/**
 * Best-effort, flag-gated producer for the brand taste-learning loop (PR2,
 * Phase 3). Operator structural edits on the userless weekly run — approving or
 * rejecting a generated creative in the review tray, regenerating a creative, or
 * deleting a synthesized post — write a TENANT-scoped taste signal on the post's
 * visual-style lens (visual_style = the brand kit's style_vibe). v1 maps actions
 * structurally with NO LLM: reject/changes/regenerate/delete => rejected,
 * approve => approved.
 *
 * Every write is wrapped + non-fatal: a taste write must NEVER break an operator
 * action (matching the repo's best-effort convention on these hot edit routes).
 * Gated by ARIES_POST_EDIT_TASTE_LEARNING_ENABLED (default OFF) — when OFF this
 * is a pure no-op that never touches the DB.
 */
import { isPostEditTasteLearningEnabled } from './post-edit-taste-learning-env';
import { applyTenantTasteSignal, visualStyleLens } from './taste-profile-store';

type TasteSignalDeps = {
  /** Override the flag check (tests). Defaults to isPostEditTasteLearningEnabled. */
  enabled?: () => boolean;
  /** Override the writer (tests). Defaults to applyTenantTasteSignal. */
  apply?: typeof applyTenantTasteSignal;
};

/**
 * Record one tenant-scoped taste signal on an explicit (dimension, value).
 * Returns true when a signal was written (flag ON + valid lens + write OK),
 * false otherwise (flag OFF, missing lens, or a swallowed write error). Never
 * throws — a failed taste write logs and is dropped so the operator action it
 * rides on still succeeds.
 */
export async function recordPostEditTasteSignal(
  input: {
    tenantId: string;
    dimension: string | null | undefined;
    value: string | null | undefined;
    outcome: 'approved' | 'rejected';
    weight?: number;
  },
  deps: TasteSignalDeps = {},
): Promise<boolean> {
  const enabled = deps.enabled ?? isPostEditTasteLearningEnabled;
  if (!enabled()) return false;
  const tenantId = input.tenantId?.trim();
  const dimension = input.dimension?.trim();
  const value = input.value?.trim();
  if (!tenantId || !dimension || !value) return false;
  try {
    const apply = deps.apply ?? applyTenantTasteSignal;
    await apply({ tenantId, dimension, value, outcome: input.outcome, weight: input.weight });
    return true;
  } catch (err) {
    console.warn('[review-edit-taste] tenant taste signal write failed (non-fatal)', {
      tenantId,
      dimension,
      outcome: input.outcome,
      error: (err as Error)?.message ?? String(err),
    });
    return false;
  }
}

/**
 * Convenience producer: record a taste signal from a brand kit's style_vibe —
 * the SAME visual-style lens the post-synthesis stamp uses, so the value written
 * here matches what was stamped on the post. No-op when style_vibe is empty.
 */
export async function recordStyleVibeTasteSignal(
  input: {
    tenantId: string;
    styleVibe: string | null | undefined;
    outcome: 'approved' | 'rejected';
    weight?: number;
  },
  deps: TasteSignalDeps = {},
): Promise<boolean> {
  const lens = visualStyleLens(input.styleVibe);
  if (!lens) return false;
  return recordPostEditTasteSignal(
    {
      tenantId: input.tenantId,
      dimension: lens.dimension,
      value: lens.value,
      outcome: input.outcome,
      weight: input.weight,
    },
    deps,
  );
}
