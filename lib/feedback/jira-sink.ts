/**
 * The direct JIRA REST mirror. Turns a durable feedback record into one JIRA
 * issue (POST /rest/api/3/issue) in the configured project, replacing the
 * Google-Sheet mirror so everything lands in JIRA for tracking.
 *
 * Design rules (mirror feedback-sink.ts):
 *  - Never throws to the caller. The route's contract is "the durable row is
 *    already saved"; this returns a status the route records, so a failed mirror
 *    is retryable, not fatal.
 *  - Authenticates with HTTP Basic (email:apiToken). The token is read from
 *    config and NEVER logged or included in an error string.
 *  - The target project (AA / Aries AI) is team-managed. Every submission is
 *    created as the configured issue type (default "Task"; "Bug" and "Story"
 *    also exist and can be selected via JIRA_FEEDBACK_ISSUE_TYPE), with the
 *    category carried in the summary/labels/body and the JIRA priority driven
 *    from the classified severity (see SEVERITY_TO_PRIORITY).
 */

import type { FeedbackJiraConfig } from './feedback-config';
import type { FeedbackSeverity } from './options';
import { appServedScreenshotLink } from './screenshot-link';
import type { FeedbackSubmissionRecord, FeedbackSyncResult } from './types';

/** Hard cap on the JIRA create call so a hung API never blocks the request. */
const JIRA_TIMEOUT_MS = 10_000;

/** JIRA summary hard limit is 255 chars; keep headroom for the prefix. */
const SUMMARY_MAX = 250;

/** Slugify a value into a JIRA-label-safe token (no spaces; ascii word chars + dot/dash). */
export function toLabel(prefix: string, value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${prefix}-${slug}` : '';
}

/** Labels applied to every feedback issue, for filtering/triage in JIRA. */
export function feedbackLabels(record: FeedbackSubmissionRecord): string[] {
  const labels = [
    'aries-feedback',
    toLabel('cat', record.category),
    toLabel('sev', record.severity),
    toLabel('env', record.environment),
    toLabel('auth', record.authState),
  ].filter(Boolean);
  // De-dupe while preserving order.
  return Array.from(new Set(labels));
}

/**
 * Feedback severity → JIRA priority NAME. Live createmeta check (2026-07-04):
 * on project AA the Task/Sub-task/Epic create screens carry the priority field
 * (Highest/High/Medium/Low/Lowest all exist), but the Bug and Story screens do
 * NOT — a create that sends `priority` for those issue types is rejected with
 * an HTTP 400 naming the field. Before this map, the sink sent no priority, so
 * every feedback issue took JIRA's project default ("Medium") regardless of
 * the classified severity.
 *
 * Two layers keep issue creation from ever breaking on priority:
 *  - an unmapped severity yields null and the field is omitted; and
 *  - a create rejected over the priority field is retried once without it and
 *    the rejection memoized (see syncFeedbackToJira), mirroring
 *    backend/feedback/report-sync.ts — a screen/scheme change can only ever
 *    cost the priority, never the ticket.
 */
const SEVERITY_TO_PRIORITY: Record<FeedbackSeverity, string> = {
  Blocker: 'Highest',
  High: 'High',
  Medium: 'Medium',
  Low: 'Low',
};

/** The JIRA priority name for a submission's severity, or null when unmapped. */
export function feedbackPriorityName(record: FeedbackSubmissionRecord): string | null {
  return SEVERITY_TO_PRIORITY[record.severity] ?? null;
}

/**
 * Memo: the target project rejected the `priority` field (not on its create
 * screen). Later creates skip the field up front instead of re-paying a doomed
 * first attempt on every submission. Process-wide, matching the equivalent
 * memo in backend/feedback/report-sync.ts.
 */
let priorityFieldUnsupported = false;

/** Test seam: forget a memoized priority-field rejection. */
export function resetPriorityFieldSupportForTests(): void {
  priorityFieldUnsupported = false;
}

/** One-line, length-bounded issue summary: "[Feedback] <Category> — <comment>". */
export function buildJiraSummary(record: FeedbackSubmissionRecord): string {
  const firstLine = record.comment.replace(/\s+/g, ' ').trim();
  const prefix = `[Feedback] ${record.category} — `;
  const room = Math.max(16, SUMMARY_MAX - prefix.length);
  const body = firstLine.length > room ? `${firstLine.slice(0, room - 1)}…` : firstLine;
  return `${prefix}${body || 'No description'}`;
}

type AdfNode = Record<string, unknown>;

function adfText(text: string): AdfNode {
  return { type: 'text', text };
}

/** A text node that renders as a clickable link when href is an http(s) URL. */
function adfMaybeLink(text: string, href: string | null): AdfNode {
  if (href && /^https?:\/\//i.test(href)) {
    return { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] };
  }
  return adfText(text);
}

function adfBullet(label: string, valueNode: AdfNode): AdfNode {
  return {
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] }, valueNode],
      },
    ],
  };
}

/**
 * Build the issue body in Atlassian Document Format (required by REST v3).
 * The comment leads; a metadata bullet list follows; console errors (if any)
 * go in a code block. Every text node is guaranteed non-empty (JIRA rejects
 * empty-text nodes).
 */
export function buildAdfDescription(
  record: FeedbackSubmissionRecord,
  screenshotLink: string | null,
): AdfNode {
  const content: AdfNode[] = [
    { type: 'paragraph', content: [adfText(record.comment.trim() || 'No description provided.')] },
  ];

  const meta: AdfNode[] = [
    adfBullet('Severity', adfText(record.severity)),
    adfBullet('Category', adfText(record.category)),
    adfBullet('Tenant', adfText(record.tenantId)),
    adfBullet('Auth state', adfText(record.authState)),
    adfBullet('Environment', adfText(record.environment)),
  ];
  if (record.pageUrl) meta.push(adfBullet('Page', adfMaybeLink(record.pageUrl, record.pageUrl)));
  if (record.viewport) meta.push(adfBullet('Viewport', adfText(record.viewport)));
  if (record.userAgent) meta.push(adfBullet('Browser', adfText(record.userAgent)));
  if (screenshotLink) meta.push(adfBullet('Screenshot', adfMaybeLink('view screenshot', screenshotLink)));
  meta.push(adfBullet('Submission ID', adfText(record.submissionId)));
  meta.push(adfBullet('Submitted', adfText(record.createdAtIso)));

  content.push({ type: 'bulletList', content: meta });

  const errors = (record.consoleErrors ?? []).filter((e) => typeof e === 'string' && e.trim());
  if (errors.length > 0) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Console errors', marks: [{ type: 'strong' }] }],
    });
    content.push({ type: 'codeBlock', content: [adfText(errors.join('\n'))] });
  }

  return { type: 'doc', version: 1, content };
}

/** The full `fields` object for POST /rest/api/3/issue. */
export function buildJiraIssueFields(
  config: FeedbackJiraConfig,
  record: FeedbackSubmissionRecord,
  screenshotLink: string | null,
  withPriority = true,
): Record<string, unknown> {
  const priorityName = withPriority ? feedbackPriorityName(record) : null;
  return {
    project: { key: config.projectKey },
    issuetype: { name: config.issueType },
    summary: buildJiraSummary(record),
    description: buildAdfDescription(record, screenshotLink),
    labels: feedbackLabels(record),
    // Drive JIRA priority from the classified severity, else JIRA stamps its
    // project default (which made every feedback issue "Medium"). Omitted when
    // unmapped so a scheme mismatch can never fail issue creation.
    ...(priorityName ? { priority: { name: priorityName } } : {}),
  };
}

function authHeader(config: FeedbackJiraConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type JiraCreateAttempt =
  | { ok: true; issueKey: string | null }
  | { ok: false; status: number | null; error: string; detail: string };

/** One POST /rest/api/3/issue attempt with its own timeout; never throws. */
async function attemptJiraCreate(
  record: FeedbackSubmissionRecord,
  config: FeedbackJiraConfig,
  screenshotLink: string | null,
  withPriority: boolean,
  fetchImpl: typeof fetch,
): Promise<JiraCreateAttempt> {
  const url = `${config.baseUrl}/rest/api/3/issue`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JIRA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader(config),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        fields: buildJiraIssueFields(config, record, screenshotLink, withPriority),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Surface JIRA's structured error (errorMessages / errors) but NEVER the
      // request — so the token in the Authorization header can't leak into logs.
      let detail = '';
      try {
        const body = (await response.json()) as {
          errorMessages?: unknown;
          errors?: Record<string, unknown>;
        };
        const msgs = Array.isArray(body.errorMessages) ? body.errorMessages.join('; ') : '';
        const fieldErrs = body.errors ? Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
        detail = [msgs, fieldErrs].filter(Boolean).join(' | ').slice(0, 500);
      } catch {
        detail = '';
      }
      return {
        ok: false,
        status: response.status,
        error: `jira create failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        detail,
      };
    }

    const created = (await response.json().catch(() => ({}))) as { key?: string };
    return { ok: true, issueKey: typeof created.key === 'string' ? created.key : null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      status: null,
      error: aborted ? `jira create timed out after ${JIRA_TIMEOUT_MS}ms` : errorText(error),
      detail: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** True when JIRA rejected the create over the priority field itself. */
function isPriorityFieldRejection(attempt: JiraCreateAttempt): boolean {
  return !attempt.ok && attempt.status === 400 && /priorit/i.test(attempt.detail);
}

/**
 * Create one JIRA issue for a submission. Optionally accepts a fetch impl (tests
 * inject a fake). Returns a uniform FeedbackSyncResult; never throws. The token
 * is never placed in the returned error.
 *
 * Priority degrade: when the target create screen rejects the `priority` field
 * (HTTP 400 naming it — AA's Bug/Story screens do this today), the create is
 * retried once without the field and the rejection memoized, so a screen or
 * scheme change can only ever cost the priority, never the ticket.
 */
export async function syncFeedbackToJira(
  record: FeedbackSubmissionRecord,
  config: FeedbackJiraConfig,
  appBaseUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedbackSyncResult> {
  const screenshotLink = record.screenshot
    ? appServedScreenshotLink({ appBaseUrl }, record.submissionId)
    : null;

  const withPriority = !priorityFieldUnsupported;
  let attempt = await attemptJiraCreate(record, config, screenshotLink, withPriority, fetchImpl);
  if (withPriority && isPriorityFieldRejection(attempt)) {
    priorityFieldUnsupported = true;
    attempt = await attemptJiraCreate(record, config, screenshotLink, false, fetchImpl);
  }

  if (!attempt.ok) {
    return { status: 'failed', screenshotLink, error: attempt.error, destination: 'jira', issueKey: null };
  }
  return { status: 'synced', screenshotLink, error: null, destination: 'jira', issueKey: attempt.issueKey };
}
