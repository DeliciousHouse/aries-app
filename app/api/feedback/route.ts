import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';
import { syncFeedbackToSheet } from '@/lib/feedback/feedback-sink';
import {
  countRecentSubmissions,
  ensureFeedbackTable,
  recordSheetSync,
  upsertFeedbackSubmission,
} from '@/lib/feedback/feedback-store';
import {
  clientIpFromHeaders,
  hashIp,
  validateSubmission,
} from '@/lib/feedback/submission';
import type {
  FeedbackAuthState,
  FeedbackSubmissionRecord,
} from '@/lib/feedback/types';

// Touches pg + node:crypto + next-auth — must run on the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read the session WITHOUT throwing. This endpoint is intentionally public: the
 * reported bugs include users who can't log in, so feedback must work while
 * unauthenticated. We never call getTenantContext() here (it throws); we read
 * auth() defensively and fall back to "unauthenticated".
 */
async function readAuthState(): Promise<{
  tenantId: string;
  authState: FeedbackAuthState;
}> {
  try {
    const session = await auth();
    if (session?.user?.id && session.user.tenantId) {
      return { tenantId: String(session.user.tenantId), authState: 'authenticated' };
    }
    if (session?.user?.id) {
      // Logged in but no tenant resolved yet (e.g. mid-onboarding).
      return { tenantId: 'unauthenticated', authState: 'authenticated' };
    }
  } catch {
    // Treat any auth resolution failure as unauthenticated rather than blocking.
  }
  return { tenantId: 'unauthenticated', authState: 'unauthenticated' };
}

export async function POST(req: Request): Promise<NextResponse> {
  const config = resolveFeedbackConfig();
  if (!config.enabled) {
    return NextResponse.json({ status: 'error', error: 'feedback_disabled' }, { status: 503 });
  }

  // Reject oversized bodies up front so a malicious payload never gets buffered
  // into memory by req.json(). Ceiling covers a 5 MB base64 screenshot (~6.7 MB)
  // plus the small text fields.
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const contentLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ status: 'error', error: 'payload_too_large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: 'error', error: 'invalid_json' }, { status: 400 });
  }

  const validation = validateSubmission(body);
  if (!validation.ok) {
    return NextResponse.json(
      { status: 'error', error: validation.error, fieldErrors: validation.fieldErrors },
      { status: 422 },
    );
  }
  const input = validation.value;

  const ipHash = hashIp(clientIpFromHeaders(req.headers));
  const { tenantId, authState } = await readAuthState();

  // Build the durable record. Per the meeting decision (spec §11), we capture
  // tenant identity only — NOT user id / email — so user_id stays null.
  const record: FeedbackSubmissionRecord = {
    submissionId: input.submissionId,
    tenantId,
    authState,
    userId: null,
    category: input.category,
    severity: input.severity,
    comment: input.comment,
    pageUrl: input.context.pageUrl,
    userAgent: input.context.userAgent ?? req.headers.get('user-agent'),
    viewport: input.context.viewport,
    consoleErrors: input.context.consoleErrors,
    environment: config.environment,
    screenshot: input.screenshot,
    ipHash,
    createdAtIso: new Date().toISOString(),
  };

  // 1) Durable persist FIRST — this is the "never silently drop" guarantee.
  let isNew = true;
  let priorSheetStatus: 'pending' | 'synced' | 'skipped' | 'failed' = 'pending';
  try {
    await ensureFeedbackTable();

    // Throttle abuse on the public endpoint by origin. The current submission's
    // own row is excluded, so retrying an already-recorded submission is never
    // blocked (spec §9 "allow retry").
    const recent = await countRecentSubmissions(
      { ipHash, excludeSubmissionId: record.submissionId },
      60,
    );
    if (recent >= config.rateLimitPerHour) {
      return NextResponse.json({ status: 'error', error: 'rate_limited' }, { status: 429 });
    }

    ({ isNew, sheetSyncStatus: priorSheetStatus } = await upsertFeedbackSubmission(record));
  } catch (error) {
    console.error('[feedback]', {
      event: 'persist-failed',
      submissionId: record.submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Nothing was stored — tell the client to keep the input and retry.
    return NextResponse.json(
      { status: 'error', error: 'persist_failed', submissionId: record.submissionId, retryable: true },
      { status: 503 },
    );
  }

  // 2) Mirror to the centralized Google Sheet via Composio (resilient).
  // Idempotency: if this submission's row was already mirrored on a prior attempt,
  // do NOT append again (the Sheet append itself is not idempotent) — a retry
  // after a lost ack must not produce a second row (spec §10 "one row per submission").
  if (!isNew && priorSheetStatus === 'synced') {
    return NextResponse.json({
      status: 'ok',
      submissionId: record.submissionId,
      sheetSync: 'synced',
    });
  }

  const sync = await syncFeedbackToSheet(record, config);
  await recordSheetSync(record.submissionId, {
    status: sync.status,
    screenshotLink: sync.screenshotLink,
    error: sync.error,
  }).catch((error) => {
    console.error('[feedback]', {
      event: 'record-sync-failed',
      submissionId: record.submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // A failed Sheet write is surfaced as retryable (spec §9.6): the durable row is
  // saved, so a retry re-attempts the mirror without duplicating.
  if (sync.status === 'failed') {
    console.error('[feedback]', {
      event: 'sheet-sync-failed',
      submissionId: record.submissionId,
      error: sync.error,
    });
    return NextResponse.json(
      {
        status: 'error',
        error: 'sheet_sync_failed',
        submissionId: record.submissionId,
        retryable: true,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    status: 'ok',
    submissionId: record.submissionId,
    sheetSync: sync.status,
  });
}
