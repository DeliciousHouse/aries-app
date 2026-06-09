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
import { loadSlackConfigForTenant, type SlackTenantConfig } from './config-store';

export type SlackNotificationResult = {
  delivered: boolean;
  /** Why it did not deliver: disabled | no_tenant_config | duplicate | post_failed | <slack error>. */
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
  /** Channel override; when set, skips the per-tenant resolver (test/override seam). */
  channel?: string;
  /** Injectable for tests. */
  pool?: Pool;
  clientDeps?: SlackClientDeps;
  env?: Partial<Record<string, string | undefined>>;
  /** Per-tenant Slack config resolver. Injectable for tests; defaults to loadSlackConfigForTenant. */
  resolveConfig?: (tenantId: number | string | null | undefined) => Promise<SlackTenantConfig | null>;
}

/**
 * Post a "needs approval" message for a marketing job stage. No-op when the flag
 * is off, no per-tenant Slack config resolves, or the (job, stage) notification
 * was already sent. Never throws. Call fire-and-forget from the callback path.
 */
export async function notifyApprovalRequired(
  input: NotifyApprovalRequiredInput,
): Promise<SlackNotificationResult> {
  const env = input.env ?? process.env;
  if (!isSlackNotificationsEnabled(env)) {
    return { delivered: false, reason: 'disabled' };
  }

  const pool = input.pool ?? defaultPool;
  const tenantId =
    input.tenantId == null ? null : Number(input.tenantId);
  const tenantIdForDb = Number.isFinite(tenantId as number) ? (tenantId as number) : null;

  // Dedup FIRST. The (job, stage) key does not depend on the resolved channel
  // or token, so check it before resolving config — this short-circuits
  // reconciler re-deliveries (and any duplicate) WITHOUT decrypting a bot token
  // or issuing the resolver's reads. The row records DELIVERY, not a claim, so a
  // failed post leaves no row and the next re-delivery retries (the reconciler
  // is the durable backstop); the rare race double-ping is cheap (the dashboard
  // is the source of truth).
  const dedupKey = `approval:${input.jobId}:${input.stage}`;
  if (await alreadyDelivered(pool, dedupKey)) {
    return { delivered: false, reason: 'duplicate' };
  }

  // Resolve channel + bot token for THIS tenant. An explicit input.channel
  // override keeps the legacy clientDeps/env-token path (test/override seam);
  // otherwise the per-tenant resolver supplies both. A null result means "no
  // Slack config for this tenant" — skip cleanly, with no cross-tenant global
  // fallback unless the operator explicitly set SLACK_SINGLE_TENANT_CHANNEL.
  // The default resolver honors this call's env + pool so injection is consistent.
  let channel = (input.channel ?? '').trim();
  let resolvedBotToken: string | undefined;
  if (!channel) {
    const resolveConfig =
      input.resolveConfig ?? ((tid) => loadSlackConfigForTenant(tid, { env, pool }));
    const cfg = await resolveConfig(input.tenantId);
    if (!cfg) {
      console.warn('[slack-notify] no per-tenant Slack config; skipping approval notification', {
        jobId: input.jobId,
        stage: input.stage,
        // Never log the resolved config / token.
      });
      return { delivered: false, reason: 'no_tenant_config' };
    }
    channel = cfg.channel;
    resolvedBotToken = cfg.botToken;
  }

  const { text, blocks } = buildApprovalRequiredMessage({
    stage: input.stage,
    prompt: input.prompt,
    brandName: input.brandName,
    reviewUrl: approvalReviewUrl(input.appBaseUrl, input.jobId),
  });

  // Per-tenant token (when resolved) wins. On the override path resolvedBotToken
  // is undefined, so postSlackMessage falls back to clientDeps.botToken ??
  // process.env.SLACK_BOT_TOKEN as before. On the resolver path the config was
  // non-null, so resolvedBotToken is always a real token — we never silently
  // fall back to the global token for a tenant that lacks one.
  const clientDeps: SlackClientDeps = {
    ...input.clientDeps,
    botToken: resolvedBotToken ?? input.clientDeps?.botToken,
  };
  const result = await postSlackMessage({ channel, text, blocks }, clientDeps);
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
