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

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import pool from '@/lib/db';

import { resolveCustomerSlug } from './impact';
import type { FeedbackReportConfig } from './report-config';
import { validateReportScreenshot } from './report-screenshot';
import type { ReportSubmitter } from './report-submitter';
import {
  ensureFeedbackReportsTable,
  getFeedbackReportById,
  insertReportWithLimits,
  withFeedbackReportSyncLock,
  type FeedbackReportRecord,
  type FeedbackReportRow,
} from './report-store';
import {
  poolSyncStore,
  rowToSyncable,
  syncReportToJira,
  type SyncableReport,
} from './report-sync';
import type { ValidatedReportRequest } from './report-validation';

export type { ReportSubmitter } from './report-submitter';

export interface SubmitReportResponseBody {
  submission_id: string | null;
  jira_ticket_key: string | null;
  status:
    | 'synced'
    | 'pending_retry'
    | 'failed'
    | 'rate_limited'
    | 'idempotency_conflict'
    | 'persist_failed';
  screenshot_discarded: string | null;
  error?: string;
}

export interface SubmitReportResult {
  httpStatus: 201 | 202 | 409 | 429 | 503;
  body: SubmitReportResponseBody;
}

export interface SubmitReportDeps {
  pool?: Pool;
  ensureTable?: typeof ensureFeedbackReportsTable;
  insert?: typeof insertReportWithLimits;
  sync?: typeof syncReportToJira;
  getById?: typeof getFeedbackReportById;
  withSyncLock?: typeof withFeedbackReportSyncLock;
  now?: () => Date;
}

function requestFingerprint(
  input: ValidatedReportRequest,
  screenshot: { bytes: Buffer; mime: string } | null,
  discarded: string | null,
): string {
  // Bind the original screenshot field even when validation discards it. Two
  // different oversized/invalid images can share one discard reason, but key
  // reuse must still fail closed as changed-payload tampering. The request body
  // is capped and JSON-parsed by the route, so this digest is bounded and
  // deterministic for a browser retry without retaining the raw input.
  const submittedScreenshotDigest =
    input.screenshot == null
      ? null
      : createHash('sha256').update(JSON.stringify(input.screenshot)).digest('hex');
  const screenshotDigest = screenshot
    ? createHash('sha256').update(screenshot.bytes).digest('hex')
    : null;
  return createHash('sha256')
    .update(
      JSON.stringify({
        category: input.category,
        impact: input.impact,
        title: input.title,
        description: input.description,
        screenshot: screenshot ? { mime: screenshot.mime, digest: screenshotDigest } : null,
        submittedScreenshotDigest,
        screenshotDiscarded: discarded,
      }),
    )
    .digest('hex');
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
  const getById = deps.getById ?? getFeedbackReportById;
  const withSyncLock = deps.withSyncLock ?? withFeedbackReportSyncLock;
  const id = input.idempotencyKey;
  const createdAt = (deps.now ?? (() => new Date()))();

  // A malformed/oversized screenshot is discarded with a reason — it never
  // sinks the report and never 4xxes.
  const shot = validateReportScreenshot(input.screenshot, config.maxImageBytes);

  const record: FeedbackReportRecord = {
    id,
    requestFingerprint: requestFingerprint(input, shot.screenshot, shot.discarded),
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
  // BEFORE the row lands). A matching idempotency replay bypasses both limits
  // and is reconciled from its original durable row.
  let replayRow: FeedbackReportRow | null = null;
  try {
    await ensureTable(db);
    const inserted = await insert(db, record, {
      userRateLimitPerHour: config.userRateLimitPerHour,
      dedupWindowSeconds: config.dedupWindowSeconds,
    });
    if (inserted.outcome === 'idempotency_conflict') {
      return {
        httpStatus: 409,
        body: {
          submission_id: null,
          jira_ticket_key: null,
          status: 'idempotency_conflict',
          screenshot_discarded: null,
          error: 'This submission key cannot be reused. Please submit again.',
        },
      };
    }
    if (inserted.outcome === 'replay') {
      replayRow = inserted.report;
    } else if (inserted.outcome !== 'ok') {
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
  const freshSyncable: SyncableReport = {
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

  try {
    return await withSyncLock(db, record.id, async (lockClient) => {
      // A replay may have waited behind the original request's Jira cycle.
      // Reload after acquiring the same report lock so it sees the final key
      // and never starts a second create/search cycle concurrently.
      const latest = (await getById(lockClient, record.id)) ?? replayRow;
      if (latest && latest.status !== 'pending') {
        return {
          httpStatus: latest.jira_ticket_key ? 201 : 202,
          body: {
            submission_id: latest.id,
            jira_ticket_key: latest.jira_ticket_key,
            status: latest.status,
            screenshot_discarded: shot.discarded,
          },
        };
      }

      const syncable = latest ? rowToSyncable(latest) : freshSyncable;
      let ticketKey: string | null = null;
      let syncStatus: 'synced' | 'pending_retry' | 'failed' = 'pending_retry';
      try {
        const result = await sync(syncable, config, poolSyncStore(lockClient));
        ticketKey = result.ticketKey;
        syncStatus = result.status;
      } catch (error) {
        // Store-write failures inside the sync leave the row 'pending'; the
        // stale-pending reclaim recovers it. The report itself is safe.
        console.error('[feedback-report]', {
          event: 'inline-sync-failed',
          submissionId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 201 whenever a ticket exists (even if the attachment is still
      // syncing); 202 when parked for the retry sweep.
      return {
        httpStatus: ticketKey ? 201 : 202,
        body: {
          submission_id: record.id,
          jira_ticket_key: ticketKey,
          status: syncStatus,
          screenshot_discarded: shot.discarded,
        },
      };
    });
  } catch (error) {
    // Lock/read failures also leave the committed row for stale-pending retry.
    console.error('[feedback-report]', {
      event: 'inline-sync-failed',
      submissionId: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      httpStatus: 202,
      body: {
        submission_id: record.id,
        jira_ticket_key: replayRow?.jira_ticket_key ?? null,
        status: 'pending_retry',
        screenshot_discarded: shot.discarded,
      },
    };
  }
}
