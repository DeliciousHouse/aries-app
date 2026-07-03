/**
 * Jira delivery for customer incident reports (SC-70 port) — the ONE place
 * that can call Jira create. Shared by the inline submit path and the retry
 * sweep so the idempotency invariant is provable by inspection:
 *
 * INVARIANT (SC-70) — search-before-create: every sync cycle first
 * short-circuits on a stored jira_ticket_key (attach-only completion), then
 * JQL-searches the `aries-sub-<id>` idempotency label, and only creates when
 * BOTH miss. A "created but not recorded" crash is therefore duplicate-proof.
 * A search failure leaves the row retryable and never reaches create.
 *
 * INVARIANT (SC-70) — priority is mapped server-side from the impact enum.
 * Aries adaptation: project AA's team-managed Bug screen currently rejects the
 * `priority` field, so a create that 400s on priority is retried once without
 * it and the outcome is memoized per process (self-heals either way when the
 * SC-71 scheme association changes). The impact still rides as a label.
 */

import type { Pool } from 'pg';

import { buildReportAdf, buildReportSummary } from './report-adf';
import type { FeedbackReportConfig, FeedbackReportJiraConfig } from './report-config';
import {
  idempotencyLabel,
  priorityForImpact,
  reportLabels,
} from './impact';
import {
  JiraReportError,
  getJiraReportClient,
  type JiraReportTransport,
} from './jira-report-client';
import { FEEDBACK_IMPACT_OPTIONS } from './report-options';
import { screenshotFilename } from './report-screenshot';
import {
  markReportSynced,
  markReportTicketKey,
  recordReportFailure,
  type FeedbackReportRow,
} from './report-store';

export interface SyncableReport {
  id: string;
  customerSlug: string;
  category: string;
  impact: string;
  title: string;
  description: string;
  submitterName: string | null;
  submitterEmail: string | null;
  screenshot: { bytes: Buffer; mime: string } | null;
  jiraTicketKey: string | null;
  attempts: number;
  createdAtIso: string;
}

export function rowToSyncable(row: FeedbackReportRow): SyncableReport {
  return {
    id: row.id,
    customerSlug: row.customer_slug,
    category: row.category,
    impact: row.impact,
    title: row.title,
    description: row.description,
    submitterName: row.submitter_name,
    submitterEmail: row.submitter_email,
    screenshot:
      row.screenshot_bytes && row.screenshot_mime
        ? { bytes: row.screenshot_bytes, mime: row.screenshot_mime }
        : null,
    jiraTicketKey: row.jira_ticket_key,
    attempts: row.attempts,
    createdAtIso:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Store mutations the sync needs — injectable so tests run without Postgres. */
export interface ReportSyncStore {
  markTicketKey(id: string, key: string): Promise<void>;
  markSynced(id: string): Promise<void>;
  recordFailure(
    id: string,
    outcome: { error: string; bumpAttempts: boolean; maxAttempts: number },
  ): Promise<void>;
}

export function poolSyncStore(pool: Pool): ReportSyncStore {
  return {
    markTicketKey: (id, key) => markReportTicketKey(pool, id, key),
    markSynced: (id) => markReportSynced(pool, id),
    recordFailure: (id, outcome) => recordReportFailure(pool, id, outcome),
  };
}

export interface ReportSyncResult {
  status: 'synced' | 'pending_retry' | 'failed';
  ticketKey: string | null;
}

// Per-process memo: AA's Bug screen rejects `priority` today. First create per
// process pays one extra round-trip discovering that; later creates skip it.
let priorityFieldUnsupported = false;

/** Test seam. */
export function resetPriorityFieldMemoForTests(): void {
  priorityFieldUnsupported = false;
}

function impactAnswerText(impact: string): string {
  return FEEDBACK_IMPACT_OPTIONS.find((o) => o.value === impact)?.label ?? impact;
}

export function buildIssueFields(
  jira: FeedbackReportJiraConfig,
  report: SyncableReport,
  withPriority: boolean,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: { key: jira.projectKey },
    issuetype: { name: jira.issueType },
    summary: buildReportSummary(report.title),
    description: buildReportAdf({
      description: report.description,
      impactAnswer: impactAnswerText(report.impact),
      category: report.category,
      contact: {
        name: report.submitterName,
        email: report.submitterEmail,
        company: report.customerSlug,
      },
      reportId: report.id,
      submittedAtIso: report.createdAtIso,
    }),
    labels: reportLabels(report.id, report.customerSlug, report.impact),
  };
  if (withPriority) {
    fields.priority = { name: priorityForImpact(report.impact) };
  }
  return fields;
}

function isPriorityFieldRejection(error: unknown): boolean {
  return (
    error instanceof JiraReportError &&
    error.status === 400 &&
    /priorit/i.test(error.message)
  );
}

/** The status a failed cycle lands in, mirroring recordReportFailure's SQL. */
function failureStatus(
  report: SyncableReport,
  bumpAttempts: boolean,
  maxAttempts: number,
): 'pending_retry' | 'failed' {
  return bumpAttempts && report.attempts + 1 >= maxAttempts ? 'failed' : 'pending_retry';
}

/**
 * Drive one report through key-check → label search → create → attach →
 * synced. Never throws on Jira errors (rows park); store errors propagate so
 * the row stays 'pending' and the stale-pending reclaim recovers it.
 */
export async function syncReportToJira(
  report: SyncableReport,
  config: FeedbackReportConfig,
  store: ReportSyncStore,
  clientOverride?: JiraReportTransport,
): Promise<ReportSyncResult> {
  const jira = config.jira;
  if (!jira) {
    await store.recordFailure(report.id, {
      error: 'jira_not_configured',
      bumpAttempts: false,
      maxAttempts: config.retryMaxAttempts,
    });
    return { status: 'pending_retry', ticketKey: null };
  }

  const client = clientOverride ?? getJiraReportClient(jira);
  let ticketKey = report.jiraTicketKey;

  // 1) Idempotency: stored key short-circuits; else search the label.
  if (!ticketKey) {
    try {
      ticketKey = await client.searchIssueKeyByLabel(idempotencyLabel(report.id));
    } catch (error) {
      // Search failure: row stays retryable, create is NEVER reached.
      const message = error instanceof JiraReportError ? error.message : 'jira search failed';
      await store.recordFailure(report.id, {
        error: message,
        bumpAttempts: true,
        maxAttempts: config.retryMaxAttempts,
      });
      return { status: failureStatus(report, true, config.retryMaxAttempts), ticketKey: null };
    }
    if (ticketKey) {
      await store.markTicketKey(report.id, ticketKey);
    }
  }

  // 2) Create — only when both the stored key and the label search missed.
  if (!ticketKey) {
    try {
      try {
        ticketKey = await client.createIssue({
          fields: buildIssueFields(jira, report, !priorityFieldUnsupported),
        });
      } catch (error) {
        if (!priorityFieldUnsupported && isPriorityFieldRejection(error)) {
          ticketKey = await client.createIssue({
            fields: buildIssueFields(jira, report, false),
          });
          priorityFieldUnsupported = true;
        } else {
          throw error;
        }
      }
    } catch (error) {
      const message = error instanceof JiraReportError ? error.message : 'jira create failed';
      await store.recordFailure(report.id, {
        error: message,
        bumpAttempts: true,
        maxAttempts: config.retryMaxAttempts,
      });
      return { status: failureStatus(report, true, config.retryMaxAttempts), ticketKey: null };
    }
    // Record the key BEFORE the attach so a crash here is attach-only work.
    await store.markTicketKey(report.id, ticketKey);
  }

  // 3) Attach (when bytes are still on the row), then mark synced.
  if (report.screenshot) {
    try {
      await client.attachScreenshot(
        ticketKey,
        report.screenshot.bytes,
        report.screenshot.mime,
        screenshotFilename(report.id, report.screenshot.mime),
      );
    } catch (error) {
      // Key is stored, bytes are kept — the sweep finishes the attach.
      const message = error instanceof JiraReportError ? error.message : 'jira attach failed';
      await store.recordFailure(report.id, {
        error: message,
        bumpAttempts: true,
        maxAttempts: config.retryMaxAttempts,
      });
      return { status: failureStatus(report, true, config.retryMaxAttempts), ticketKey };
    }
  }

  await store.markSynced(report.id);
  return { status: 'synced', ticketKey };
}
