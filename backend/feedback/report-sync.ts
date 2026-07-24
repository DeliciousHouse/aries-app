/**
 * Jira delivery for customer incident reports (SC-70 port) — the ONE place
 * that can call Jira create. Shared by the inline submit path and the retry
 * sweep so the idempotency invariant is provable by inspection:
 *
 * INVARIANT (SC-70) — search-before-create: every sync cycle first
 * short-circuits on a stored jira_ticket_key, then
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

import type { Pool, PoolClient } from 'pg';

import { buildReportAdf, buildReportSummary } from './report-adf';
import type { FeedbackReportConfig, FeedbackReportJiraConfig } from './report-config';
import type { ReportSubmitterAttribution } from './report-submitter';
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
import { FEEDBACK_IMPACT_OPTIONS } from '@/lib/feedback/report-options';
import {
  markReportCreateInFlight,
  markReportCreateUncertain,
  markReportSynced,
  markReportTicketKey,
  recordReportCreateReconcileMiss,
  recordReportFailure,
  type FeedbackAttachmentState,
  type JiraCreateState,
  type FeedbackReportRow,
} from './report-store';

export interface SyncableReport {
  id: string;
  submitterType: ReportSubmitterAttribution;
  tenantId: string;
  submitterId: string;
  category: string;
  impact: string;
  jiraTicketKey: string | null;
  jiraCreateState: JiraCreateState;
  jiraCreateToken: string | null;
  attachmentState: FeedbackAttachmentState;
  attempts: number;
  createdAtIso: string;
}

export function rowToSyncable(row: FeedbackReportRow): SyncableReport {
  return {
    id: row.id,
    submitterType: row.submitter_type,
    tenantId: row.tenant_id,
    submitterId: row.submitter_id,
    category: row.category,
    impact: row.impact,
    jiraTicketKey: row.jira_ticket_key,
    jiraCreateState: row.jira_create_state,
    jiraCreateToken: row.jira_create_token,
    attachmentState: row.attachment_state,
    attempts: row.attempts,
    createdAtIso:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Store mutations the sync needs — injectable so tests run without Postgres. */
export interface ReportSyncStore {
  markCreateInFlight(id: string, token: string): Promise<void>;
  markCreateUncertain(id: string, error: string): Promise<void>;
  recordCreateReconcileMiss(id: string, maxAttempts: number): Promise<void>;
  markTicketKey(id: string, key: string): Promise<void>;
  markSynced(id: string): Promise<void>;
  recordFailure(
    id: string,
    outcome: { error: string; bumpAttempts: boolean; maxAttempts: number },
  ): Promise<void>;
}

export function poolSyncStore(pool: Pool | PoolClient): ReportSyncStore {
  return {
    markCreateInFlight: (id, token) => markReportCreateInFlight(pool, id, token),
    markCreateUncertain: (id, error) => markReportCreateUncertain(pool, id, error),
    recordCreateReconcileMiss: (id, maxAttempts) =>
      recordReportCreateReconcileMiss(pool, id, maxAttempts),
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
    summary: buildReportSummary(`Customer incident report ${report.id}`),
    description: buildReportAdf({
      impactAnswer: impactAnswerText(report.impact),
      category: report.category,
      submitterType: report.submitterType,
      tenantId: report.tenantId,
      submitterId: report.submitterId,
      reportId: report.id,
      submittedAtIso: report.createdAtIso,
    }),
    labels: reportLabels(report.id, report.impact, report.submitterType),
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
 * Drive one report through key-check → label search → create → synced. Raw
 * report text and screenshots are absent from this boundary by type. Never
 * throws on Jira errors (rows park); store errors propagate so
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

  // A prior process reached the create boundary but did not durably record the
  // resulting key. Jira search is eventually consistent, so one empty result
  // must never authorize a duplicate create. Keep reconciling with bounded
  // backoff; the terminal status exposes an operator remediation signal.
  if (
    !ticketKey &&
    (report.jiraCreateState === 'in_flight' ||
      report.jiraCreateState === 'uncertain' ||
      report.jiraCreateState === 'completed')
  ) {
    await store.recordCreateReconcileMiss(report.id, config.retryMaxAttempts);
    return {
      status: failureStatus(report, true, config.retryMaxAttempts),
      ticketKey: null,
    };
  }

  // 2) Create — only when both the stored key and the label search missed.
  if (!ticketKey) {
    const createToken = report.jiraCreateToken ?? idempotencyLabel(report.id);
    // The fence MUST commit before the first network byte can leave. A crash or
    // a lost response thereafter can only enter reconciliation, never create.
    await store.markCreateInFlight(report.id, createToken);
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
      await store.markCreateUncertain(report.id, message);
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

  // Screenshots and all raw report content remain in Aries. Even rows left in
  // an old in-flight/uncertain attachment state are reconciled by marking the
  // private record synced; no Jira attachment network call is ever repeated.
  await store.markSynced(report.id);
  return { status: 'synced', ticketKey };
}
