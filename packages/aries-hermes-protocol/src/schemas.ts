import { z } from 'zod';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Bump when any schema changes. Both Aries and Hermes must agree on this. */
// 1.2.0: additive — regenerate_creative gained optional edit_instruction +
// source_image_basename for image-to-image edits (MINOR per semver; older
// consumers strip the fields and degrade to a plain regenerate).
export const PROTOCOL_VERSION = '1.2.0';

/** Strict semver pattern: MAJOR.MINOR.PATCH with optional pre-release suffix. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$/;

/** Zod schema for a valid semver string. */
export const SemverSchema = z.string().regex(SEMVER_RE, 'must be a valid semver string (e.g. "1.1.0")');

/**
 * Returns true when `incoming` is a valid semver string whose major version
 * matches this build's PROTOCOL_VERSION major.
 * - Minor bumps (1.0 → 1.1) are additive and accepted in either direction.
 * - Major mismatches (1.x vs 2.x) are rejected fail-loud.
 * - Malformed strings (e.g. "1.not-semver", "1", "") are always rejected.
 */
export function isCompatibleProtocolVersion(incoming: string): boolean {
  if (!SEMVER_RE.test(incoming)) return false;
  const inMajor = Number(incoming.split('.')[0]);
  const ourMajor = Number(PROTOCOL_VERSION.split('.')[0]);
  return inMajor === ourMajor;
}

// ---------------------------------------------------------------------------
// Stage enums
// ---------------------------------------------------------------------------

/**
 * The four marketing pipeline stages as Aries knows them internally.
 * Used as the `stage` field on execution run records and callback payloads
 * that Aries originates (run submissions, poll-bridge synthetic callbacks).
 */
export const MarketingStageSchema = z.enum([
  'research',
  'strategy',
  'production',
  'publish',
]);

/**
 * Post-v0.1.3.43 convention: `approval.stage` is the NEXT stage that needs
 * human approval (not the completing stage). This is the canonical enum that
 * both Aries validators and Hermes workflow authors must agree on.
 *
 * Convention: "next-stage-to-gate"
 *   research completes → approval.stage = 'strategy'
 *   strategy completes → approval.stage = 'production'
 *   production completes → approval.stage = 'publish'
 */
export const ApprovalStageSchema = z.enum([
  'strategy',
  'production',
  'publish',
  // Legacy values kept for backward-compat during Hermes migration
  'plan',
  'creative',
  'video',
]);

/**
 * The granular workflow step that requires human review.
 * Hermes emits this to let Aries route the approval to the right UI panel.
 */
export const ApprovalStepSchema = z.enum([
  'approve_weekly_plan',
  'approve_post_copy',
  'approve_image_creatives',
  'approve_video_script',
  'approve_video_render',
  'approve_publish',
]);

// ---------------------------------------------------------------------------
// Callback payload stages (Hermes granular run-step names)
// ---------------------------------------------------------------------------

export const CallbackStageSchema = z.enum([
  'intake',
  'research',
  'planning',
  'plan_review',
  'copy_production',
  'image_briefing',
  'image_creatives',
  'image_generation',
  'creative_review',
  'video_script',
  'video_review',
  'video_render',
  'publish_review',
  'completed',
  'failed',
  'production',
  'approval',
  'publish',
  'strategy',
]);

// ---------------------------------------------------------------------------
// Callback status
// ---------------------------------------------------------------------------

export const CallbackStatusSchema = z.enum([
  'running',
  'requires_approval',
  'completed',
  'failed',
  'cancelled',
  // 'stopped' is a terminal cancellation state Hermes uses alongside 'cancelled'
  'stopped',
]);

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export const CallbackErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  retryable: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Approval envelope
// ---------------------------------------------------------------------------

export const CallbackApprovalSchema = z.object({
  /**
   * Next-stage-to-gate convention (post-v0.1.3.43).
   * Aries normalizes completing-stage values from Hermes at the boundary;
   * once inside Aries this field always reflects the NEXT stage to approve.
   */
  stage: ApprovalStageSchema,
  approval_step: ApprovalStepSchema.optional(),
  workflow_step_id: z.string(),
  prompt: z.string(),
  resume_token: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Callback payload (Hermes → Aries)
// ---------------------------------------------------------------------------

export const HermesRunCallbackPayloadSchema = z.object({
  /** Idempotency key — Aries deduplicates on this field. Must be non-empty and non-whitespace. */
  event_id: z.string().min(1).regex(/\S/, 'event_id must contain at least one non-whitespace character'),
  /** Aries-side execution run identifier (arun_<uuid>). */
  aries_run_id: z.string(),
  /** Hermes-side run identifier. Optional for legacy flows. */
  hermes_run_id: z.string().optional(),
  status: CallbackStatusSchema,
  /** Granular Hermes workflow step that just completed or paused. */
  stage: CallbackStageSchema.optional(),
  /** Stage outputs. Either a single object or an array of stage result objects. */
  output: z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())),
  ]).optional(),
  artifacts: z.array(z.unknown()).optional(),
  /** Present only when status === 'requires_approval'. */
  approval: CallbackApprovalSchema.optional(),
  error: CallbackErrorSchema.optional(),
  /**
   * Protocol version the sender was built against (e.g. "1.1.0").
   * Optional for Hermes-side backward compat during migration.
   * When present, must be valid semver; major-version mismatch is rejected by Aries.
   */
  protocol_version: SemverSchema.optional(),
});

// ---------------------------------------------------------------------------
// Run submission payload (Aries → Hermes /v1/runs)
// ---------------------------------------------------------------------------

export const CallbackAuthSchema = z.object({
  type: z.literal('internal_api_secret_bearer'),
  secret_ref: z.string(),
  callback_token: z.string(),
});

export const CallbackContextSchema = z.object({
  workflow_key: z.string(),
  aries_run_id: z.string(),
  job_id: z.string().nullable().optional(),
  tenant_id: z.string().nullable().optional(),
  approval_id: z.string().nullable().optional(),
  approval_step: ApprovalStepSchema.nullable().optional(),
  workflow_version: z.string().optional(),
  auto_advance: z.boolean().optional(),
  regenerate_creative: z.object({
    source_run_id: z.string(),
    source_creative_id: z.string(),
    // Image edit (image-to-image): additive + optional, so a plain regenerate is
    // unchanged. When present, the run edits the existing source image instead of
    // regenerating it. Carried so the callback echo preserves the edit context.
    edit_instruction: z.string().optional(),
    source_image_basename: z.string().optional(),
  }).optional(),
});

export const HermesRunSubmissionSchema = z.object({
  /** OpenAI-style chat-completions input — must be a non-empty string. */
  input: z.string(),
  instructions: z.string().optional(),
  session_id: z.string().optional(),
  workflow_key: z.string().optional(),
  action: z.enum(['run', 'resume']).optional(),
  aries_run_id: z.string().optional(),
  approval_step: ApprovalStepSchema.nullable().optional(),
  approval_id: z.string().nullable().optional(),
  resume_token: z.string().optional(),
  approved: z.boolean().optional(),
  job_id: z.string().nullable().optional(),
  tenant_id: z.string().nullable().optional(),
  callback_url: z.string(),
  callback_auth: CallbackAuthSchema,
  callback_context: CallbackContextSchema,
  idempotency_key: z.string().optional(),
  /** Protocol version Aries was built against (valid semver). Hermes should echo or compare. */
  protocol_version: SemverSchema,
});

// ---------------------------------------------------------------------------
// Run status response (Hermes GET /v1/runs/{run_id})
// ---------------------------------------------------------------------------

export const HermesRunStatusResponseSchema = z.object({
  run_id: z.string(),
  status: CallbackStatusSchema,
  output: z.union([
    z.string(),
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())),
  ]).optional(),
  error: z.string().optional(),
});
