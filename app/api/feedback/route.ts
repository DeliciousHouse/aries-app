import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';
import { syncFeedbackToSheet } from '@/lib/feedback/feedback-sink';
import { classifySeverity } from '@/lib/feedback/severity-classifier';
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

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OVER_LIMIT = Symbol('over-limit');

/**
 * Read the request body as text without ever buffering more than `maxBytes`.
 * Counts the actual stream (so a missing/chunked Content-Length can't bypass the
 * cap) and aborts mid-read past the limit, returning the OVER_LIMIT sentinel.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string | typeof OVER_LIMIT> {
  // Fast path: an honest oversized Content-Length is rejected before reading.
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return OVER_LIMIT;

  const reader = req.body?.getReader();
  if (!reader) {
    const text = await req.text();
    return Buffer.byteLength(text) > maxBytes ? OVER_LIMIT : text;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return OVER_LIMIT;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(req: Request): Promise<NextResponse> {
  const config = resolveFeedbackConfig();
  if (!config.enabled) {
    return NextResponse.json({ status: 'error', error: 'feedback_disabled' }, { status: 503 });
  }

  // Read the body with a hard byte cap so a malicious payload never buffers
  // unbounded into memory. Fails closed: a missing/invalid Content-Length does
  // NOT bypass the cap (the stream itself is counted), and an over-cap body is
  // rejected mid-read. Ceiling covers a 5 MB base64 screenshot (~6.7 MB) + fields.
  const raw = await readBodyCapped(req, MAX_BODY_BYTES);
  if (raw === OVER_LIMIT) {
    return NextResponse.json({ status: 'error', error: 'payload_too_large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
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

  // 1) Persist durably. Order: rate-limit -> classify -> upsert. Classification
  // sits before the DB write so the row carries an inferred severity, but the
  // "never silently drop" property still holds: classify is bounded and never
  // throws (falls back to a heuristic), so the upsert always runs within the
  // timeout; and if the request dies before the upsert, the client keeps the
  // input and retries with the same submission_id (idempotent).
  let isNew = true;
  let priorSheetStatus: 'pending' | 'synced' | 'skipped' | 'failed' = 'pending';
  let record!: FeedbackSubmissionRecord;
  try {
    await ensureFeedbackTable();

    // Throttle abuse on the public endpoint by origin BEFORE the LLM call, so
    // spam can't trigger classification runs. The current submission's own row is
    // excluded, so retrying an already-recorded submission is never blocked (§9).
    const recent = await countRecentSubmissions(
      { ipHash, excludeSubmissionId: input.submissionId },
      60,
    );
    if (recent >= config.rateLimitPerHour) {
      return NextResponse.json({ status: 'error', error: 'rate_limited' }, { status: 429 });
    }

    // Severity is inferred server-side (users no longer pick it — it confused
    // people). Bounded + heuristic fallback, so it never blocks long or fails.
    const { severity } = await classifySeverity(
      { comment: input.comment, category: input.category },
      config.severityLlm,
    );

    // Per the meeting decision (spec §11), capture tenant identity only — NOT
    // user id / email — so user_id stays null.
    record = {
      submissionId: input.submissionId,
      tenantId,
      authState,
      userId: null,
      category: input.category,
      severity,
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

    ({ isNew, sheetSyncStatus: priorSheetStatus } = await upsertFeedbackSubmission(record));
  } catch (error) {
    console.error('[feedback]', {
      event: 'persist-failed',
      submissionId: input.submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Nothing was stored — tell the client to keep the input and retry.
    return NextResponse.json(
      { status: 'error', error: 'persist_failed', submissionId: input.submissionId, retryable: true },
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
