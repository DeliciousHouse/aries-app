/**
 * The Composio → Google Sheet mirror. Turns a durable feedback record into one
 * appended Sheet row (spec §8) and writes the screenshot link into the row.
 *
 * Design rules:
 *  - Reuses the existing Composio seam (LiveComposioGateway / executeTool) rather
 *    than touching @composio/core directly, so it stays mockable and the SDK
 *    loads lazily.
 *  - Never throws to the caller. The API route's contract is "the durable row is
 *    already saved"; this returns a status the route records, so a failed mirror
 *    is retryable, not fatal.
 *  - Screenshot link resolves to the app-served durable image
 *    (/api/feedback/screenshot/:id). The spec (§7) accepts Drive "or equivalent"
 *    durable storage with a link in the row; serving the stored image satisfies
 *    that without depending on a Drive action slug (a §11 open item).
 */

import {
  createComposioGateway,
  type ComposioGateway,
} from '@/backend/integrations/composio/composio-client';
import type { FeedbackComposioConfig, FeedbackConfig } from './feedback-config';
import { appServedScreenshotLink } from './screenshot-link';
import { syncFeedbackToJira } from './jira-sink';
import type {
  FeedbackSheetRow,
  FeedbackSubmissionRecord,
  FeedbackSyncResult,
} from './types';

// Re-exported so existing importers (and tests) keep their import paths.
export type { FeedbackSyncResult } from './types';
export { appServedScreenshotLink } from './screenshot-link';

/** Toolkit slug for the Google Sheets connected account. */
const GOOGLESHEETS_TOOLKIT = 'googlesheets';

/**
 * Column order mirrored into the Sheet — the single source of truth for the
 * header row an operator sets up, and the order rows are written. Matches the
 * schema table in the spec (§8) exactly.
 */
export const FEEDBACK_SHEET_COLUMNS = [
  'Submission ID',
  'Timestamp',
  'Tenant ID',
  'Auth state',
  'Category',
  'Severity',
  'Comment',
  'Page URL',
  'Browser / UA',
  'Viewport',
  'Console errors',
  'Screenshot link',
  'Environment',
] as const;

/** Flatten the record into the typed Sheet row (screenshot link injected late). */
export function toFeedbackSheetRow(
  record: FeedbackSubmissionRecord,
  screenshotLink: string,
): FeedbackSheetRow {
  return {
    submissionId: record.submissionId,
    timestamp: record.createdAtIso,
    tenantId: record.tenantId,
    authState: record.authState,
    category: record.category,
    severity: record.severity,
    comment: record.comment,
    pageUrl: record.pageUrl ?? '',
    userAgent: record.userAgent ?? '',
    viewport: record.viewport ?? '',
    consoleErrors: (record.consoleErrors ?? []).join('\n'),
    screenshotLink,
    environment: record.environment,
  };
}

/** Ordered string cells for the Sheet append, aligned to FEEDBACK_SHEET_COLUMNS. */
export function feedbackRowToCells(row: FeedbackSheetRow): string[] {
  return [
    row.submissionId,
    row.timestamp,
    row.tenantId,
    row.authState,
    row.category,
    row.severity,
    row.comment,
    row.pageUrl,
    row.userAgent,
    row.viewport,
    row.consoleErrors,
    row.screenshotLink,
    row.environment,
  ];
}

/** Convert a 1-based column count to its trailing A1 column letter (13 -> "M"). */
export function columnLetter(count: number): string {
  let n = Math.max(1, count);
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * Arguments for the verified Composio action GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND.
 * Per its schema the keys are camelCase (spreadsheetId) and the target tab is a
 * tab-qualified A1 `range` (NOT a sheet_name field); values is a 2D array.
 */
export function buildSheetAppendArguments(
  composio: FeedbackComposioConfig,
  cells: string[],
): Record<string, unknown> {
  const lastCol = columnLetter(FEEDBACK_SHEET_COLUMNS.length);
  return {
    spreadsheetId: composio.spreadsheetId,
    // Single-quote the tab so names with spaces parse; A:<lastCol> spans our columns.
    range: `'${composio.sheetTab}'!A:${lastCol}`,
    // One appended row (2D array, majorDimension ROWS).
    values: [cells],
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mirror one submission into the Google Sheet. Optionally accepts a gateway
 * (tests inject a fake); otherwise builds the live gateway from config.
 */
export async function syncFeedbackToSheet(
  record: FeedbackSubmissionRecord,
  config: FeedbackConfig,
  gatewayOverride?: ComposioGateway,
): Promise<FeedbackSyncResult> {
  const composio = config.composio;
  const screenshotLink = record.screenshot
    ? appServedScreenshotLink(config, record.submissionId)
    : '';

  if (!composio) {
    // Not configured: the durable DB row stands in until the §11 open items land.
    return {
      status: 'skipped',
      screenshotLink: record.screenshot ? screenshotLink : null,
      error: null,
    };
  }

  let gateway: ComposioGateway;
  try {
    gateway =
      gatewayOverride ??
      createComposioGateway({
        apiKey: composio.apiKey,
        toolkitVersion: composio.toolkitVersion,
        authConfigIdFor: () => null,
        toolkitSlugFor: () => GOOGLESHEETS_TOOLKIT,
        actionSlugFor: () => null,
        defaultAuthConfigId: () => null,
      });
  } catch (error) {
    return { status: 'failed', screenshotLink: screenshotLink || null, error: errorText(error) };
  }

  try {
    const row = toFeedbackSheetRow(record, screenshotLink);
    const cells = feedbackRowToCells(row);
    const result = await gateway.executeTool(composio.appendActionSlug, {
      connectedAccountId: composio.connectedAccountId,
      arguments: buildSheetAppendArguments(composio, cells),
    });
    if (!result.successful) {
      return {
        status: 'failed',
        screenshotLink: screenshotLink || null,
        error: result.error ?? 'sheet append reported unsuccessful',
      };
    }
    return { status: 'synced', screenshotLink: screenshotLink || null, error: null, destination: 'sheet' };
  } catch (error) {
    return { status: 'failed', screenshotLink: screenshotLink || null, error: errorText(error), destination: 'sheet' };
  }
}

/**
 * Mirror a submission to the configured external tracker. JIRA takes precedence
 * over the Google Sheet when both are configured (the migration target); the
 * Sheet remains as a fallback for deployments still on it, and when neither is
 * configured the result is 'skipped' (the durable DB row stands in). The route
 * calls this single entry point and records the uniform result.
 */
export async function syncFeedback(
  record: FeedbackSubmissionRecord,
  config: FeedbackConfig,
  overrides?: { gateway?: ComposioGateway; fetchImpl?: typeof fetch },
): Promise<FeedbackSyncResult> {
  if (config.jira) {
    return syncFeedbackToJira(record, config.jira, config.appBaseUrl, overrides?.fetchImpl ?? fetch);
  }
  if (config.composio) {
    return syncFeedbackToSheet(record, config, overrides?.gateway);
  }
  return {
    status: 'skipped',
    screenshotLink: record.screenshot ? appServedScreenshotLink(config, record.submissionId) : null,
    error: null,
    destination: 'none',
  };
}
