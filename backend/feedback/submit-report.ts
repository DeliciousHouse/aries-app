/**
 * Submit pipeline for customer incident reports (SC-70 port).
 *
 * INVARIANT (SC-70) — persist FIRST: the report row is inserted and COMMITTED
 * (with the rate limit + dedup checks in the same transaction) before any Jira
 * I/O. A Jira exception cannot roll back the insert; whatever happens after
 * the commit only changes the row's sync status.
 *
 * INVARIANT (SC-70) — uniform response shape: 201 and 202 both carry all four
 * fields { submission_id, jira_ticket_key, status, screenshot_discarded },
 * null where not applicable.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import pool from '@/lib/db';

import { resolveCustomerSlug } from './impact';
import type { FeedbackReportConfig } from './report-config';
import { validateReportScreenshot } from './report-screenshot';
import type { ReportSubmitter } from './report-submitter';
import {
  ensureFeedbackReportsTable,
  insertReportWithLimits,
  type FeedbackReportRecord,
} from './report-store';
import { poolSyncStore, syncReportToJira, type SyncableReport } from './report-sync';
import type { ValidatedReportRequest } from './report-validation';

export type { ReportSubmitter } from './report-submitter';

export interface SubmitReportResponseBody {
  submission_id: string | null;
  jira_ticket_key: string | null;
  status: 'synced' | 'pending_retry' | 'rate_limited' | 'persist_failed';
  screenshot_discarded: string | null;
  error?: string;
}

export interface SubmitReportResult {
  httpStatus: 201 | 202 | 429 | 503;
  body: SubmitReportResponseBody;
}

export interface SubmitReportDeps {
  pool?: Pool;
  ensureTable?: typeof ensureFeedbackReportsTable;
  insert?: typeof insertReportWithLimits;
  sync?: typeof syncReportToJira;
  newId?: () => string;
  now?: () => Date;
}

export async function submitFeedbackReport(
  input: ValidatedReportRequest,
  submitter: ReportSubmitter,
  config: FeedbackReportConfig,
  deps: SubmitReportDeps = {},
): Promise<SubmitReportResult> {
  const db = deps.pool ?? pool;
  const ensureTable = deps.ensureTable ?? ensureFeedbackReportsTable;
  const insert = deps.insert ?? insertReportWithLimits;
  const sync = deps.sync ?? syncReportToJira;
  const id = (deps.newId ?? randomUUID)();
  const createdAt = (deps.now ?? (() => new Date()))();

  // A malformed/oversized screenshot is discarded with a reason — it never
  // sinks the report and never 4xxes.
  const shot = validateReportScreenshot(input.screenshot, config.maxImageBytes);

  const record: FeedbackReportRecord = {
    id,
    submitterType: submitter.attribution,
    tenantId: submitter.tenantId ?? 'unknown',
    submitterId: submitter.userId,
    submitterEmail: submitter.email,
    submitterName: submitter.name,
    // The public tenant bucket is a rate-limit/storage boundary, not a
    // customer. Do not turn it into a fabricated customer identity in Jira.
    customerSlug:
      submitter.attribution === 'anonymous'
        ? 'unknown'
        : resolveCustomerSlug({
            tenantSlug: submitter.tenantSlug,
            tenantName: null,
            tenantId: submitter.tenantId,
          }),
    category: input.category,
    impact: input.impact,
    title: input.title,
    description: input.description,
    screenshot: shot.screenshot,
  };

  // 1) Persist durably (rate limit + dedup run inside the same transaction,
  // BEFORE the row lands).
  try {
    await ensureTable(db);
    const inserted = await insert(db, record, {
      userRateLimitPerHour: config.userRateLimitPerHour,
      dedupWindowSeconds: config.dedupWindowSeconds,
    });
    if (inserted.outcome !== 'ok') {
      return {
        httpStatus: 429,
        body: {
          submission_id: null,
          jira_ticket_key: null,
          status: 'rate_limited',
          screenshot_discarded: shot.discarded,
          error:
            inserted.outcome === 'duplicate'
              ? 'This looks identical to a report you just sent. Give it a minute.'
              : 'Too many reports in the last hour. Please try again later.',
        },
      };
    }
  } catch (error) {
    console.error('[feedback-report]', {
      event: 'persist-failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      httpStatus: 503,
      body: {
        submission_id: null,
        jira_ticket_key: null,
        status: 'persist_failed',
        screenshot_discarded: null,
        error: 'We could not save your report. Please retry.',
      },
    };
  }

  // 2) The row is committed — from here every outcome is a success response.
  const syncable: SyncableReport = {
    id: record.id,
    submitterType: record.submitterType,
    customerSlug: record.customerSlug,
    category: record.category,
    impact: record.impact,
    title: record.title,
    description: record.description,
    submitterName: record.submitterName,
    submitterEmail: record.submitterEmail,
    screenshot: record.screenshot,
    jiraTicketKey: null,
    attempts: 0,
    createdAtIso: createdAt.toISOString(),
  };

  let ticketKey: string | null = null;
  let syncStatus: 'synced' | 'pending_retry' = 'pending_retry';
  try {
    const result = await sync(syncable, config, poolSyncStore(db));
    ticketKey = result.ticketKey;
    if (result.status === 'synced') syncStatus = 'synced';
  } catch (error) {
    // Store-write failures inside the sync leave the row 'pending'; the
    // stale-pending reclaim recovers it. The report itself is safe.
    console.error('[feedback-report]', {
      event: 'inline-sync-failed',
      submissionId: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 201 whenever a ticket exists (even if the attachment is still syncing);
  // 202 when the report is parked for the retry sweep.
  return {
    httpStatus: ticketKey ? 201 : 202,
    body: {
      submission_id: record.id,
      jira_ticket_key: ticketKey,
      status: syncStatus,
      screenshot_discarded: shot.discarded,
    },
  };
}
