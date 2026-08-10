/**
 * backend/marketing/job-kind.ts
 *
 * AA-153 — what kind of job a workspace is showing.
 *
 * The post workspace header hardcoded the eyebrow "Post", so a week-long
 * `weekly_social_content` job read as a single post (QA sweep 2026-07-20,
 * ISSUE-009). The truth was already on disk: `createSocialContentJobRuntimeDocument`
 * stamps a top-level `job_type` derived from `inputs.request.jobType` with the
 * exact strict equality the pipeline uses, and the reel companion stamps a
 * deterministic `created_by = "reel:<sourceWeeklyJobId>"` marker.
 *
 * This reads those two fields and nothing else. In particular it does NOT go
 * near `orchestrator.ts::requestedJobTypeFromDoc`, which is hardcoded to
 * 'weekly_social_content' and drives stage routing — changing that is a
 * behavior change to the pipeline, not a label fix.
 */

import type { MarketingJobKind } from '@/lib/api/marketing';
import type { SocialContentJobRuntimeDocument } from './runtime-state';

/** The reel companion's `created_by` marker (see weekly-reel-trigger.ts). */
const REEL_CREATED_BY_PREFIX = 'reel:';

export function resolveMarketingJobKind(
  doc: Pick<SocialContentJobRuntimeDocument, 'job_type' | 'created_by'> | null | undefined,
): MarketingJobKind {
  if (!doc) return 'weekly_social_content';

  // A reel companion is submitted as a one_off_post, so the marker has to win
  // over job_type or every reel would read as a plain post.
  const createdBy = typeof doc.created_by === 'string' ? doc.created_by : '';
  if (createdBy.startsWith(REEL_CREATED_BY_PREFIX)) {
    return 'reel';
  }

  // Note: `job_type` is only ever 'weekly_social_content' or 'one_off_post' in
  // practice — createSocialContentJobRuntimeDocument collapses
  // 'one_off_campaign' into 'one_off_post'. Both one-off shapes are a single
  // post from the operator's point of view, so the label is the same either way.
  return doc.job_type === 'one_off_post' || doc.job_type === 'one_off_campaign'
    ? 'one_off_post'
    : 'weekly_social_content';
}
