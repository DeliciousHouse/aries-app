/**
 * OUTBOUND Slack notifications for the marketing pipeline (Phase 4 PR 2).
 *
 * Scope of PR2: notify a Slack channel when a marketing job reaches an approval
 * gate that a HUMAN still needs to act on, so operators stop polling the
 * dashboard for "what's waiting on me." Completion/failure pings and the inbound
 * approve-from-Slack flow (reaction/reply -> resume the pipeline) are deliberately
 * out of scope here — the inbound direction mutates prod marketing state from an
 * external webhook and gets its own focused review.
 *
 * Design rules (match the repo's callback ethos):
 *   - Best-effort + non-fatal. Slack is a convenience; the dashboard remains the
 *     source of truth. Every path returns a result and never throws.
 *   - Idempotent across re-delivery. The Hermes callback is re-delivered by the
 *     reconciler under a DIFFERENT event_id than the original poll-bridge
 *     delivery, so a per-approval-id key would not dedupe (the id regenerates per
 *     delivery). We dedupe on the STABLE (job, stage) identity via the
 *     `slack_notifications` table (INSERT ... ON CONFLICT DO NOTHING), mirroring
 *     the inbound `slack_event_ids` pattern.
 *   - Flag-gated (`ARIES_SLACK_NOTIFICATIONS_ENABLED`, default OFF). When off this
 *     module is a no-op and the callback path is byte-identical to today.
 */
import type { Pool } from 'pg';

import { pool as defaultPool } from '@/lib/db';
import type { MarketingStage } from '@/backend/marketing/runtime-state';

import { isSlackNotificationsEnabled } from './notify-env';
import { postSlackMessage, type SlackClientDeps } from './client';

export type SlackNotificationResult = {
  delivered: boolean;
  /** Why it did not deliver: disabled | missing_channel | duplicate | post_failed | <slack error>. */
  reason?: string;
};

const STAGE_LABELS: Record<MarketingStage, string> = {
  research: 'Research',
  strategy: 'Weekly plan',
  production: 'Post copy & creative',
  publish: 'Publish',
};

function stageLabel(stage: MarketingStage): string {
  return STAGE_LABELS[stage] ?? stage;
}

// Slack hard-limits a section text to 3000 chars and rejects oversized blocks
// with ok:false (a silent non-delivery). Cap the untrusted Hermes prompt and the
// brand name well under the limit so a verbose prompt never costs us the ping.
const MAX_PROMPT_CHARS = 2500;
const MAX_BRAND_CHARS = 200;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Escape the three mrkdwn-significant characters per Slack's escaping rules. The
 * `prompt` is Hermes/agent-generated text crossing into a Slack channel; without
 * this it could inject mrkdwn link syntax, fake `<!channel>`/`@here` mention
 * tokens, or markup impersonating the real "Review in Aries" button.
 */
function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Per-job approval review deep link. `/social-content/review?jobId=` accepts the job id. */
export function approvalReviewUrl(appBaseUrl: string, jobId: string): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  return `${base}/social-content/review?jobId=${encodeURIComponent(jobId)}`;
}

export interface ApprovalRequiredMessageInput {
  stage: MarketingStage;
  prompt?: string | null;
  brandName?: string | null;
  reviewUrl: string;
}

/**
 * Pure Block Kit builder — no env, no DB, no network. Unit-tested directly so the
 * rendered message shape is pinned independent of delivery.
 */
export function buildApprovalRequiredMessage(input: ApprovalRequiredMessageInput): {
  text: string;
  blocks: unknown[];
} {
  const rawWho = input.brandName?.trim() ? input.brandName.trim() : 'A marketing campaign';
  const who = escapeSlackText(truncate(rawWho, MAX_BRAND_CHARS));
  const label = stageLabel(input.stage);
  const headline = `${who} needs your approval: ${label}`;
  const promptLine = input.prompt?.trim()
    ? escapeSlackText(truncate(input.prompt.trim(), MAX_PROMPT_CHARS))
    : 'A pipeline stage is paused waiting for your review.';

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:hourglass_flowing_sand: *${headline}*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: promptLine },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Review in Aries', emoji: true },
          url: input.reviewUrl,
          style: 'primary',
        },
      ],
    },
  ];

  // Plain-text fallback for notifications / no-block clients.
  const text = `${headline} — review: ${input.reviewUrl}`;
  return { text, blocks };
}

/**
 * Has this notification already been delivered? We record a dedup row ONLY after
 * a successful post (see recordNotified), so a row's existence means "delivered."
 * Fail-open: if the table is unavailable we proceed to post (better a possible
 * duplicate ping than a silent miss; the dashboard remains the source of truth).
 */
async function alreadyDelivered(pool: Pool, dedupKey: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM slack_notifications WHERE dedup_key = $1`,
      [dedupKey],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    console.warn('[slack-notify] dedup check failed — proceeding fail-open', {
      dedupKey,
      error: (error as Error)?.message ?? String(error),
    });
    return false;
  }
}

/**
 * Record a delivered notification. Written only AFTER postSlackMessage succeeds,
 * so a failed/crashed delivery leaves no row and the next callback re-delivery
 * retries the post (the reconciler is the durable backstop). ON CONFLICT DO
 * NOTHING keeps it idempotent under a concurrent double-delivery. Non-fatal.
 */
async function recordNotified(
  pool: Pool,
  dedupKey: string,
  kind: string,
  tenantId: number | null,
  marketingJobId: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO slack_notifications (dedup_key, kind, tenant_id, marketing_job_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [dedupKey, kind, tenantId, marketingJobId],
    );
  } catch (error) {
    console.warn('[slack-notify] dedup record failed — ping delivered, may re-ping on re-delivery', {
      dedupKey,
      error: (error as Error)?.message ?? String(error),
    });
  }
}

export interface NotifyApprovalRequiredInput {
  tenantId: number | string | null | undefined;
  jobId: string;
  stage: MarketingStage;
  prompt?: string | null;
  brandName?: string | null;
  appBaseUrl: string;
  /** Channel override; defaults to SLACK_NOTIFY_CHANNEL. */
  channel?: string;
  /** Injectable for tests. */
  pool?: Pool;
  clientDeps?: SlackClientDeps;
  env?: Partial<Record<string, string | undefined>>;
}

/**
 * Post a "needs approval" message for a marketing job stage. No-op when the flag
 * is off, the channel is unset, or the (job, stage) notification was already
 * sent. Never throws. Call fire-and-forget from the callback path.
 */
export async function notifyApprovalRequired(
  input: NotifyApprovalRequiredInput,
): Promise<SlackNotificationResult> {
  const env = input.env ?? process.env;
  if (!isSlackNotificationsEnabled(env)) {
    return { delivered: false, reason: 'disabled' };
  }

  const channel = (input.channel ?? env.SLACK_NOTIFY_CHANNEL ?? '').trim();
  if (!channel) {
    console.warn('[slack-notify] SLACK_NOTIFY_CHANNEL is not set; skipping approval notification', {
      jobId: input.jobId,
      stage: input.stage,
    });
    return { delivered: false, reason: 'missing_channel' };
  }

  const pool = input.pool ?? defaultPool;
  const tenantId =
    input.tenantId == null ? null : Number(input.tenantId);
  const tenantIdForDb = Number.isFinite(tenantId as number) ? (tenantId as number) : null;

  // Stable across reconciler re-delivery: one ping per (job, stage) gate. The
  // row records DELIVERY, not a claim — so a failed post leaves no row and the
  // next re-delivery retries (the reconciler is the durable backstop). The
  // tradeoff is a rare double-ping if two deliveries race within the post
  // latency; the dashboard is the source of truth, so a duplicate is cheap.
  const dedupKey = `approval:${input.jobId}:${input.stage}`;
  if (await alreadyDelivered(pool, dedupKey)) {
    return { delivered: false, reason: 'duplicate' };
  }

  const { text, blocks } = buildApprovalRequiredMessage({
    stage: input.stage,
    prompt: input.prompt,
    brandName: input.brandName,
    reviewUrl: approvalReviewUrl(input.appBaseUrl, input.jobId),
  });

  const result = await postSlackMessage({ channel, text, blocks }, input.clientDeps);
  if (!result.ok) {
    // Record NOTHING on failure: the next callback re-delivery retries instead
    // of permanently dropping the ping over a transient Slack outage.
    console.warn('[slack-notify] approval notification post failed', {
      jobId: input.jobId,
      stage: input.stage,
      error: result.error,
    });
    return { delivered: false, reason: result.error ?? 'post_failed' };
  }
  await recordNotified(pool, dedupKey, 'approval_required', tenantIdForDb, input.jobId);
  return { delivered: true };
}
