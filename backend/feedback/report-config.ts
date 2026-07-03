/**
 * Config for customer incident reports (SC-70 port), resolved from env.
 *
 * INVARIANT (SC-70): dark by default. With the JIRA_* vars unset the feature
 * boots cleanly: submits persist and park as pending_retry (202), the retry
 * sweep idles with one info line, and queued rows heal automatically once the
 * config lands — no code change, no flag flip.
 *
 * Aries adaptation: reuses the JIRA_* env names the legacy feedback mirror
 * already ships in prod (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN /
 * JIRA_PROJECT_KEY, all wired into docker-compose). JIRA_ISSUE_TOKEN — the
 * SC-70 name — is accepted as an alias for the token. The v2 issue type is
 * JIRA_INCIDENT_ISSUE_TYPE (default "Bug", which project AA has; the legacy
 * path keeps its own JIRA_FEEDBACK_ISSUE_TYPE=Task default).
 */

function str(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface FeedbackReportJiraConfig {
  /** e.g. https://sugarandleather.atlassian.net (trailing slash trimmed). */
  baseUrl: string;
  /** Atlassian account email the API token belongs to (Basic auth user). */
  email: string;
  /** Atlassian API token (secret) — never logged, scrubbed from all errors. */
  apiToken: string;
  /** Target project key, e.g. "AA". */
  projectKey: string;
  /** Issue type name to create (default "Bug"). */
  issueType: string;
}

export interface FeedbackReportConfig {
  /** Non-null only when every Jira piece is present; null ⇒ park-and-heal mode. */
  jira: FeedbackReportJiraConfig | null;
  /** Decoded screenshot cap in bytes. */
  maxImageBytes: number;
  /** Per user+tenant submissions allowed per hour. */
  userRateLimitPerHour: number;
  /** Rapid-duplicate window (same title+description) in seconds. */
  dedupWindowSeconds: number;
  /** Retry sweep cadence in minutes. */
  retryIntervalMinutes: number;
  /** Max rows claimed per sweep cycle. */
  retryBatchLimit: number;
  /** Completed failed attempts before a row goes terminal `failed`. */
  retryMaxAttempts: number;
  /** Age (minutes) after which a stranded `pending` row is reclaimed. */
  stalePendingMinutes: number;
}

function resolveJira(env: NodeJS.ProcessEnv): FeedbackReportJiraConfig | null {
  const baseUrl = str(env.JIRA_BASE_URL);
  const email = str(env.JIRA_EMAIL);
  const apiToken = str(env.JIRA_API_TOKEN) ?? str(env.JIRA_ISSUE_TOKEN);
  const projectKey = str(env.JIRA_PROJECT_KEY);
  if (!baseUrl || !email || !apiToken || !projectKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    email,
    apiToken,
    projectKey,
    issueType: str(env.JIRA_INCIDENT_ISSUE_TYPE) ?? 'Bug',
  };
}

export function resolveFeedbackReportConfig(
  env: NodeJS.ProcessEnv = process.env,
): FeedbackReportConfig {
  return {
    jira: resolveJira(env),
    maxImageBytes: int(env.FEEDBACK_MAX_IMAGE_BYTES, 2_000_000),
    userRateLimitPerHour: int(env.FEEDBACK_USER_RATE_LIMIT_PER_HOUR, 10),
    dedupWindowSeconds: int(env.FEEDBACK_DEDUP_WINDOW_SECONDS, 60),
    retryIntervalMinutes: int(env.FEEDBACK_RETRY_INTERVAL_MINUTES, 5),
    retryBatchLimit: int(env.FEEDBACK_RETRY_BATCH_LIMIT, 10),
    retryMaxAttempts: int(env.FEEDBACK_RETRY_MAX_ATTEMPTS, 5),
    stalePendingMinutes: int(env.FEEDBACK_STALE_PENDING_MINUTES, 15),
  };
}

/**
 * Worker gate for the retry sweep sidecar. Default ON — unlike the other
 * sidecars this one is inherently dormant without Jira config (it idles with a
 * single info line and touches nothing), so the default-on ship is what lets
 * parked rows heal the moment config lands. Set 0/false to force it off.
 */
export function feedbackRetryWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = str(env.ARIES_FEEDBACK_RETRY_ENABLED);
  if (flag === null) return true;
  return !/^(0|false|no|off)$/i.test(flag);
}
