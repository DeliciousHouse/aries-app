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

export function resolveFeedbackConfig(env: NodeJS.ProcessEnv = process.env): FeedbackConfig {
  // Default ON: feature is opt-out, since the button is meant to be everywhere.
  const enabled = env.FEEDBACK_ENABLED === undefined ? true : parseFlag(env.FEEDBACK_ENABLED);
  return {
    enabled,
    environment: resolveFeedbackEnvironment(env),
    appBaseUrl: str(env.APP_BASE_URL) ?? str(env.NEXTAUTH_URL) ?? str(env.AUTH_URL),
    rateLimitPerHour: int(env.FEEDBACK_RATE_LIMIT_PER_HOUR, 20),
    composio: resolveComposio(env),
  };
}
