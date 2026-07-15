import type { IntegrationCard } from '@/lib/api/integrations';
import type { BusinessProfileView, RuntimePostListItem } from '@/lib/api/aries-v1';

import { customerSafeActionErrorMessage, customerSafeUiErrorMessage } from './customer-safe-copy';

/**
 * The Generate-this-week dashboard trigger lives outside the social-content
 * /new screen so the operator can kick off a weekly run with one click after
 * onboarding, without having to fill the long-form intake. Server defaults
 * (7 days, 3 static posts, 2 images, 1 video script, 0 renders) apply when
 * `payload` is `{}`, so this client never reimplements those numbers.
 */

export const GENERATE_THIS_WEEK_LABEL = "Generate this week's content";
export const GENERATE_THIS_WEEK_BUSY_LABEL = 'Generating…';
export const GENERATE_THIS_WEEK_ENDPOINT = '/api/social-content/jobs';

export type GenerateThisWeekGate =
  | 'ready'
  | 'profile_incomplete'
  | 'profile_unavailable'
  | 'integrations_loading'
  | 'no_meta_connection'
  | 'in_progress';

export interface GenerateThisWeekPostSnapshot {
  status: RuntimePostListItem['status'];
  dashboardStatus: RuntimePostListItem['dashboardStatus'];
  approvalRequired: RuntimePostListItem['approvalRequired'];
  /** Raw execution state from the runtime doc. Terminal states ('completed',
   * 'failed', 'failed_stale') must not block the Generate gate even when the
   * workflow status falls back to 'draft'. */
  executionState: RuntimePostListItem['executionState'];
}

export interface GenerateThisWeekGateInputs {
  profile: BusinessProfileView | null;
  integrationCards: IntegrationCard[];
  integrationsPending?: boolean;
  posts: GenerateThisWeekPostSnapshot[];
}

export interface GenerateThisWeekGateState {
  gate: GenerateThisWeekGate;
  enabled: boolean;
  inProgress: boolean;
  disabledReason: string | null;
}

const GATE_REASONS: Record<Exclude<GenerateThisWeekGate, 'ready'>, string> = {
  profile_incomplete:
    'Complete your business profile in Settings before generating this week’s posts.',
  profile_unavailable:
    'Business profile data is not available right now. Try again in a moment.',
  integrations_loading: 'Checking publishing connections.',
  no_meta_connection:
    'Connect a Facebook or Instagram account before generating this week’s posts.',
  in_progress:
    'A weekly social content run is already in progress. Wait for it to finish or finalize approvals before starting another.',
};

/**
 * Terminal execution states must never count as "in progress". A failed (or
 * stale-failed) run carries `executionState === 'failed'` / `'failed_stale'`
 * even though its workflow status is still `'draft'` (the workflow layer never
 * advanced). Without this check a single failed run permanently jams the gate.
 * Mirrors the terminal check in `isPipelineActive` in runtime-state.ts.
 */
function isTerminalExecutionState(executionState: string): boolean {
  return (
    executionState === 'completed' ||
    executionState === 'failed' ||
    executionState === 'failed_stale'
  );
}

function isInProgressCampaign(campaign: GenerateThisWeekPostSnapshot): boolean {
  // Terminal runs (completed, failed, failed_stale) must not block the gate
  // even when their workflow status still reads as 'draft'.
  if (isTerminalExecutionState(campaign.executionState)) {
    return false;
  }

  // The dashboard runtime list represents submitted/running/requires_approval
  // jobs as `draft`, `in_review`, or `approvalRequired === true`. Treat any of
  // these as in-progress so the manual trigger does not double-fire while a
  // run is still moving through Hermes callbacks or human approval.
  if (campaign.approvalRequired === true) {
    return true;
  }
  const top = campaign.status;
  if (top === 'draft' || top === 'in_review') {
    return true;
  }
  const dash = campaign.dashboardStatus;
  if (dash === 'draft' || dash === 'in_review') {
    return true;
  }
  return false;
}

export function evaluateGenerateThisWeekGate(
  args: GenerateThisWeekGateInputs,
): GenerateThisWeekGateState {
  const inProgress = args.posts.some(isInProgressCampaign);
  if (inProgress) {
    return {
      gate: 'in_progress',
      enabled: false,
      inProgress: true,
      disabledReason: GATE_REASONS.in_progress,
    };
  }

  if (!args.profile) {
    return {
      gate: 'profile_unavailable',
      enabled: false,
      inProgress: false,
      disabledReason: GATE_REASONS.profile_unavailable,
    };
  }
  if (args.profile.incomplete) {
    return {
      gate: 'profile_incomplete',
      enabled: false,
      inProgress: false,
      disabledReason: GATE_REASONS.profile_incomplete,
    };
  }

  if (args.integrationsPending) {
    return {
      gate: 'integrations_loading',
      enabled: false,
      inProgress: false,
      disabledReason: GATE_REASONS.integrations_loading,
    };
  }

  const hasMetaConnection = args.integrationCards.some(
    (card) =>
      (card.platform === 'facebook' || card.platform === 'instagram') &&
      card.connection_state === 'connected',
  );
  if (!hasMetaConnection) {
    return {
      gate: 'no_meta_connection',
      enabled: false,
      inProgress: false,
      disabledReason: GATE_REASONS.no_meta_connection,
    };
  }

  return { gate: 'ready', enabled: true, inProgress: false, disabledReason: null };
}

export interface GenerateThisWeekRequestBody {
  jobType: 'weekly_social_content';
  payload: Record<string, never>;
}

export function buildGenerateThisWeekRequestBody(): GenerateThisWeekRequestBody {
  // Empty payload so the server-side weekly defaults
  // (window/posts/creatives/scripts/renders) and business-profile enrichment
  // are the single source of truth. The dashboard trigger should never
  // reimplement the weekly numbers.
  return { jobType: 'weekly_social_content', payload: {} };
}

export interface GenerateThisWeekFetchResult {
  ok: boolean;
  status: number;
  jobId: string | null;
  jobStatusUrl: string | null;
  errorMessage: string | null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) {
    return null;
  }
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export async function submitGenerateThisWeek(
  fetchImpl: typeof fetch = fetch,
  baseUrl = '',
): Promise<GenerateThisWeekFetchResult> {
  const response = await fetchImpl(`${baseUrl}${GENERATE_THIS_WEEK_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGenerateThisWeekRequestBody()),
  });

  let parsed: Record<string, unknown> | null = null;
  try {
    const json = (await response.json()) as unknown;
    if (json && typeof json === 'object') {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  const jobId = readString(parsed, 'jobId');
  const jobStatusUrl = readString(parsed, 'jobStatusUrl');
  // Prefer the operator-facing sentence (`message`) the jobs handler now sends
  // alongside the machine-readable `error` code; fall back to the code for
  // older/unmapped response shapes.
  const rawError = readString(parsed, 'message') ?? readString(parsed, 'error');

  return {
    ok: response.ok,
    status: response.status,
    jobId,
    jobStatusUrl,
    errorMessage: response.ok ? null : rawError,
  };
}

/**
 * Customer-safe error copy for the trigger banner. Pipes the raw API error
 * through the existing redactor so internal-sounding tokens (oauth, internal
 * env vars, stack traces, etc.) never reach the operator UI.
 */
export function customerSafeGenerateThisWeekError(
  raw: string | null | undefined,
  fallback = 'We could not start this week’s social content run. Please try again in a moment.',
): string {
  return customerSafeActionErrorMessage(raw ?? null, fallback);
}

export { customerSafeUiErrorMessage };
