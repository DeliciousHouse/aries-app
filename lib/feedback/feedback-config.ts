/**
 * Feedback feature configuration, resolved from env. Two layers:
 *
 *  1. The capture path (button + DB persistence) is always on — the spec wants
 *     feedback collectable on every page, including for users who can't log in.
 *     A kill switch (FEEDBACK_ENABLED=false) exists for emergencies.
 *
 *  2. The Google Sheet mirror via Composio is only "configured" when every piece
 *     needed to write a row is present: a Composio API key, the centralized
 *     Google connected-account id, the spreadsheet id, and the append action
 *     slug. Following the repo's Composio convention (backend/integrations/
 *     composio/composio-config.ts), action slugs are NEVER guessed — when unset,
 *     the mirror is reported "skipped" and the durable DB row stands in as the
 *     record of truth until an operator wires the open items from spec §11.
 */

import {
  composioApiKey,
  composioToolkitVersion,
  isComposioEnabled,
  parseFlag,
} from '@/backend/integrations/providers/integration-config';

function str(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface FeedbackComposioConfig {
  apiKey: string;
  toolkitVersion: string;
  /** The single centralized Google account connected through Composio. */
  connectedAccountId: string;
  /** Target spreadsheet + tab the rows are appended to. */
  spreadsheetId: string;
  sheetTab: string;
  /** Google Sheets append action slug (verified: GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND). */
  appendActionSlug: string;
}

/**
 * Direct JIRA REST mirror. Non-null only when every piece needed to create an
 * issue is present: base URL, account email, API token, and project key. The
 * app authenticates with Basic auth (email:apiToken) against
 * `${baseUrl}/rest/api/3/issue`. JIRA takes precedence over the Google Sheet
 * mirror when both are configured.
 */
export interface FeedbackJiraConfig {
  /** e.g. https://sugarandleather.atlassian.net (trailing slash trimmed). */
  baseUrl: string;
  /** Atlassian account email the API token belongs to (Basic auth user). */
  email: string;
  /** Atlassian API token (secret) — never logged. */
  apiToken: string;
  /** Target project key, e.g. "AA" (Aries AI). */
  projectKey: string;
  /** Issue type name to create, e.g. "Task". Project AA has Task/Bug/Story/Epic/Sub-task. */
  issueType: string;
}

/** Hermes-backed severity classification (severity is inferred, not user-entered). */
export interface FeedbackSeverityLlmConfig {
  gatewayUrl: string;
  apiKey: string;
  sessionKey: string;
  /** Hard cap on the whole submit+poll classification (ms). */
  timeoutMs: number;
}

export interface FeedbackConfig {
  /** Master switch for the whole feature (button + capture). Default ON. */
  enabled: boolean;
  /** Environment label written into each row ("production", "dev", ...). */
  environment: string;
  /** Public base URL used to build the app-served screenshot fallback link. */
  appBaseUrl: string | null;
  /** Per-origin submissions allowed per hour on the public endpoint. */
  rateLimitPerHour: number;
  /** Non-null only when the Composio → Sheet mirror is fully configured. */
  composio: FeedbackComposioConfig | null;
  /** Non-null only when the direct JIRA mirror is fully configured. Preferred over `composio`. */
  jira: FeedbackJiraConfig | null;
  /** Non-null when severity should be inferred via Hermes (else heuristic only). */
  severityLlm: FeedbackSeverityLlmConfig | null;
}

/** Resolve the environment label: explicit override wins, else NODE_ENV. */
export function resolveFeedbackEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return (
    str(env.FEEDBACK_ENVIRONMENT) ??
    str(env.APP_ENV) ??
    str(env.ARIES_ENV) ??
    str(env.NODE_ENV) ??
    'unknown'
  );
}

function resolveComposio(env: NodeJS.ProcessEnv): FeedbackComposioConfig | null {
  // Respect the global Composio kill-switch (COMPOSIO_ENABLED, default OFF) so the
  // feedback mirror can't send live Composio traffic when the layer is disabled
  // org-wide or during an incident — consistent with the publish/analytics paths.
  if (!isComposioEnabled(env)) return null;

  const apiKey = composioApiKey(env);
  const connectedAccountId = str(env.COMPOSIO_FEEDBACK_GOOGLE_CONNECTED_ACCOUNT_ID);
  const spreadsheetId = str(env.FEEDBACK_GOOGLE_SHEET_ID);
  const appendActionSlug = str(env.COMPOSIO_FEEDBACK_SHEETS_APPEND_ACTION);

  // Every required piece must be present; otherwise the mirror is "not
  // configured" and we degrade to durable-DB-only (never invent a slug/account).
  if (!apiKey || !connectedAccountId || !spreadsheetId || !appendActionSlug) {
    return null;
  }

  return {
    apiKey,
    toolkitVersion: composioToolkitVersion(env),
    connectedAccountId,
    spreadsheetId,
    sheetTab: str(env.FEEDBACK_GOOGLE_SHEET_TAB) ?? 'Feedback',
    appendActionSlug,
  };
}

function resolveJira(env: NodeJS.ProcessEnv): FeedbackJiraConfig | null {
  const baseUrl = str(env.JIRA_BASE_URL);
  const email = str(env.JIRA_EMAIL);
  const apiToken = str(env.JIRA_API_TOKEN);
  const projectKey = str(env.JIRA_PROJECT_KEY);

  // Every required piece must be present; otherwise the JIRA mirror is "not
  // configured" and the dispatcher falls back (Sheet, else durable-DB-only).
  // Never invent a project/token.
  if (!baseUrl || !email || !apiToken || !projectKey) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    email,
    apiToken,
    projectKey,
    // Project AA (Aries AI) is team-managed with Task/Bug/Story/Epic/Sub-task;
    // "Task" is the safe default. Override per-deploy (e.g. "Bug") via
    // JIRA_FEEDBACK_ISSUE_TYPE — the name must exist on the target project.
    // AA's Bug/Story create screens lack the priority field; the sink degrades
    // by retrying without priority on rejection, so any type here is safe.
    issueType: str(env.JIRA_FEEDBACK_ISSUE_TYPE) ?? 'Task',
  };
}

/**
 * Severity is inferred via Hermes when the gateway is configured and the feature
 * isn't explicitly disabled. Treats an empty string as "unset" (docker-compose
 * passes "" for unmapped/blank vars) so the default stays ON without surprises.
 */
function resolveSeverityLlm(env: NodeJS.ProcessEnv): FeedbackSeverityLlmConfig | null {
  const flag = str(env.FEEDBACK_SEVERITY_LLM_ENABLED);
  if (flag !== null && !parseFlag(flag)) return null; // explicit off

  const gatewayUrl = str(env.HERMES_GATEWAY_URL);
  const apiKey = str(env.HERMES_API_SERVER_KEY);
  if (!gatewayUrl || !apiKey) return null; // no Hermes -> heuristic only

  return {
    gatewayUrl: gatewayUrl.replace(/\/+$/, ''),
    apiKey,
    sessionKey:
      str(env.HERMES_SEVERITY_SESSION_KEY) ?? str(env.HERMES_SESSION_KEY) ?? 'aries-main',
    timeoutMs: int(env.FEEDBACK_SEVERITY_TIMEOUT_MS, 6000),
  };
}

export function resolveFeedbackConfig(env: NodeJS.ProcessEnv = process.env): FeedbackConfig {
  // Default ON: feature is opt-out, since the button is meant to be everywhere.
  // Empty string counts as unset (docker-compose passes "" for blank vars), so an
  // unmapped/blank FEEDBACK_ENABLED defaults ON rather than silently hiding it.
  const enabledFlag = str(env.FEEDBACK_ENABLED);
  const enabled = enabledFlag === null ? true : parseFlag(enabledFlag);
  return {
    enabled,
    environment: resolveFeedbackEnvironment(env),
    appBaseUrl: str(env.APP_BASE_URL) ?? str(env.NEXTAUTH_URL) ?? str(env.AUTH_URL),
    rateLimitPerHour: int(env.FEEDBACK_RATE_LIMIT_PER_HOUR, 20),
    composio: resolveComposio(env),
    jira: resolveJira(env),
    severityLlm: resolveSeverityLlm(env),
  };
}
