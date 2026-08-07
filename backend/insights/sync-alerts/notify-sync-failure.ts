/**
 * backend/insights/sync-alerts/notify-sync-failure.ts
 *
 * S6-4 / AA-117 — the Slack send for a sync-failure alert.
 *
 * Resolves the tenant's OWN Slack workspace (per-tenant Option A, the same
 * resolver the approval notifier uses), so an alert about tenant A's broken sync
 * can never land in tenant B's channel. A tenant with no Slack connection is
 * skipped cleanly — there is no global fallback channel.
 *
 * Never throws: the sweep treats a false return as "not delivered" and leaves no
 * dedupe row, so the next tick retries.
 */

import type { Pool } from 'pg';

import { loadSlackConfigForTenant } from '@/backend/integrations/slack/config-store';
import { postSlackMessage, type SlackClientDeps } from '@/backend/integrations/slack/client';
import { isSlackNotificationsEnabled } from '@/backend/integrations/slack/notify-env';
import type { SyncAlertCandidate } from './sync-failure-alerts';

const CATEGORY_HINT: Record<string, string> = {
  auth: 'The channel connection needs reauthorizing.',
  rate_limit: 'The platform is rate-limiting us; it may clear on its own.',
  not_configured: 'The adapter is disabled or missing configuration.',
  other: 'Check the sync-health detail for the recorded error.',
  restart_abort: 'Runs were interrupted by a restart.',
};

export function buildSyncFailureMessage(
  candidate: SyncAlertCandidate,
  appBaseUrl: string,
): { text: string; blocks: unknown[] } {
  const platform = candidate.platform.charAt(0).toUpperCase() + candidate.platform.slice(1);
  const headline = `${platform} analytics sync has failed ${candidate.streak} times in a row`;
  const hint = CATEGORY_HINT[candidate.failureCategory] ?? CATEGORY_HINT.other;
  const url = `${appBaseUrl.replace(/\/+$/, '')}/insights`;

  return {
    text: `${headline} — ${hint} ${url}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${headline}*\n${hint}` },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Insights data for this channel is going stale. <${url}|Open Insights>`,
          },
        ],
      },
    ],
  };
}

export interface NotifySyncFailureDeps {
  pool?: Pool;
  env?: Partial<Record<string, string | undefined>>;
  clientDeps?: SlackClientDeps;
  appBaseUrl?: string;
  resolveConfig?: typeof loadSlackConfigForTenant;
  post?: typeof postSlackMessage;
}

/** Send one sync-failure alert. Returns true only on a confirmed delivery. */
export async function notifySyncFailure(
  candidate: SyncAlertCandidate,
  deps: NotifySyncFailureDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!isSlackNotificationsEnabled(env)) return false;

  const appBaseUrl = deps.appBaseUrl ?? env.APP_BASE_URL ?? '';
  if (!appBaseUrl) {
    // A link into an app we cannot name is worse than no link; and running
    // without APP_BASE_URL means this is not the app process (see the
    // architecture note in sync-failure-alerts.ts).
    console.warn('[sync-failure-alerts] APP_BASE_URL missing; not sending');
    return false;
  }

  try {
    const resolve = deps.resolveConfig ?? loadSlackConfigForTenant;
    const cfg = await resolve(candidate.tenantId, {
      env,
      pool: deps.pool,
      allowSingleTenantFallback: false,
    });
    if (!cfg) {
      // No Slack for this tenant. Not an error — and deliberately NOT a global
      // fallback channel, which would disclose one tenant's state to another.
      return false;
    }

    const { text, blocks } = buildSyncFailureMessage(candidate, appBaseUrl);
    const post = deps.post ?? postSlackMessage;
    const result = await post(
      { channel: cfg.channel, text, blocks },
      { ...deps.clientDeps, botToken: cfg.botToken },
    );
    return Boolean(result?.ok);
  } catch (error) {
    console.warn('[sync-failure-alerts] send failed (non-fatal)', {
      tenantId: candidate.tenantId,
      platform: candidate.platform,
      error: (error as Error)?.message ?? String(error),
    });
    return false;
  }
}
