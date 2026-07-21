/**
 * Reel-companion video outcome gate.
 *
 * A reel-companion job (`created_by` starting `reel:`, fired by
 * `maybeFireWeeklyReelJob` or its one-shot retry) exists to produce exactly ONE
 * publishable video reel. The Hermes content-generator agent only calls
 * video_generate ~50% of the time on reel jobs; when it doesn't, the job used
 * to complete "approved" with a reel post that had no video creative_asset —
 * a dead post that failed dispatch terminally (posts 415/416, 2026-07-13) or
 * stranded past campaign end (posts 361/362, 2026-07-06). With the synthesis
 * gate in `synthesize-publish-posts.ts` that dead post is no longer created,
 * which would leave the job reading "completed" with nothing to publish — a
 * silent failure.
 *
 * This gate runs at job completion and makes the outcome honest and loud:
 *   - a completed reel-companion job with NO video `posts` row is marked
 *     FAILED (`recordStageFailure` on production — the stage that never
 *     rendered the video), with a runtime incident + console.error; and
 *   - for an ORIGINAL companion (never a retry), one automatic retry job is
 *     fired via `maybeFireReelVideoRetryJob` — a fresh one_off_post reel job
 *     that runs the full pipeline cleanly. Bounded to one retry structurally
 *     (see weekly-reel-trigger.ts).
 *
 * Fail-open on infrastructure errors: if the posts lookup itself fails, the
 * job is left completed — a DB blip must never fail a healthy job. Idempotent
 * across reconciler re-delivery: a healthy reel job has its video post row and
 * no-ops; a failed job is terminal, so re-delivery is dropped upstream by the
 * terminal-doc guard.
 */

import {
  appendHistory,
  recordStageFailure,
  type SocialContentJobRuntimeDocument,
} from './runtime-state';
import { markSocialContentStageFailed } from '@/backend/social-content/runtime-state';
import { maybeFireReelVideoRetryJob } from './weekly-reel-trigger';

export const REEL_VIDEO_MISSING_ERROR_CODE = 'reel_video_asset_missing';

/** Any reel-companion job — the original weekly companion or its retry. */
export function isReelCompanionCreatedBy(createdBy: unknown): boolean {
  return typeof createdBy === 'string' && createdBy.startsWith('reel:');
}

type OutcomeDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

type FireRetry = typeof maybeFireReelVideoRetryJob;

export type ReelVideoOutcome =
  | { action: 'none'; reason: string }
  | {
      action: 'failed';
      retry: { fired: boolean; reelJobId?: string; reason?: string };
    };

const SELECT_VIDEO_POST_SQL = `
  SELECT 1 FROM posts
   WHERE job_id = $1 AND tenant_id = $2 AND media_type = 'video'
   LIMIT 1
`;

/**
 * Enforce the reel-companion contract on a job that just went terminal. The
 * caller is responsible for persisting the doc afterwards (the Hermes callback
 * paths all save after this runs). Never throws.
 */
export async function enforceReelCompanionVideoOutcome(
  doc: SocialContentJobRuntimeDocument,
  deps: { db: OutcomeDb; fireRetry?: FireRetry },
): Promise<ReelVideoOutcome> {
  try {
    // Only act on a job that actually completed — mid-pipeline stage
    // completions leave doc.state 'running' and are not this gate's business.
    if (doc.state !== 'completed') {
      return { action: 'none', reason: 'not_completed' };
    }
    if (!isReelCompanionCreatedBy(doc.created_by)) {
      return { action: 'none', reason: 'not_reel_companion' };
    }
    const tenantNum = Number(doc.tenant_id);
    if (!Number.isFinite(tenantNum) || tenantNum <= 0) {
      return { action: 'none', reason: 'no_tenant' };
    }

    // Source of truth: does the job have a publishable video post? This covers
    // every miss mode in one check — no content_package at all, a feed-only
    // package the clamp dropped, and a reel entry dropped by the synthesis
    // gate for having no ingested video creative_asset.
    let hasVideoPost: boolean;
    try {
      const result = await deps.db.query(SELECT_VIDEO_POST_SQL, [doc.job_id, tenantNum]);
      hasVideoPost = (result.rowCount ?? result.rows.length) > 0;
    } catch (err) {
      // Fail-open: never fail a (possibly healthy) job on a lookup error.
      console.warn('[reel-video-outcome] video-post lookup failed — leaving job completed', {
        jobId: doc.job_id,
        error: (err as Error)?.message ?? String(err),
      });
      return { action: 'none', reason: 'lookup_error' };
    }
    if (hasVideoPost) {
      return { action: 'none', reason: 'video_post_present' };
    }

    console.error('[reel-video-outcome] reel job completed with NO video post — marking failed', {
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      createdBy: doc.created_by,
    });

    const message =
      'Reel job produced no video: the production run never rendered/ingested a video creative_asset, so no reel post could be synthesized.';
    recordStageFailure(doc, 'production', {
      code: REEL_VIDEO_MISSING_ERROR_CODE,
      message,
      retryable: false,
      details: { created_by: doc.created_by ?? null },
    });
    markSocialContentStageFailed(doc, 'video_render', message);
    appendHistory(doc, `reel-companion outcome gate: ${REEL_VIDEO_MISSING_ERROR_CODE} — job marked failed`, {
      stage: 'production',
    });

    // One-shot automatic retry (original companions only — the helper itself
    // refuses `reel:retry:` markers). Best-effort: the helper never throws.
    const fireRetry = deps.fireRetry ?? maybeFireReelVideoRetryJob;
    const retry = await fireRetry({
      tenantId: tenantNum,
      failedReelJobId: doc.job_id,
      failedReelCreatedBy: doc.created_by,
      brandUrl: doc.inputs?.brand_url ?? null,
    });
    appendHistory(
      doc,
      retry.fired
        ? `reel video retry fired: ${retry.reelJobId}`
        : `reel video retry not fired: ${retry.reason ?? 'unknown'}`,
      { stage: 'production' },
    );

    return { action: 'failed', retry };
  } catch (err) {
    // Structural fail-open — this gate must never break completion bookkeeping.
    console.warn('[reel-video-outcome] gate threw — continuing', {
      jobId: doc.job_id,
      error: (err as Error)?.message ?? String(err),
    });
    return { action: 'none', reason: 'gate_error' };
  }
}
