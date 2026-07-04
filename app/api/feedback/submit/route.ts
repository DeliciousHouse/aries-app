import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { getTenantContext } from '@/lib/tenant-context';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';
import { OVER_LIMIT, readBodyCapped } from '@/lib/http/read-body-capped';
import { resolveFeedbackReportConfig } from '@/backend/feedback/report-config';
import { validateReportRequest } from '@/backend/feedback/report-validation';
import {
  submitFeedbackReport,
  type ReportSubmitter,
} from '@/backend/feedback/submit-report';

// Touches pg + node:crypto + next-auth — must run on the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ceiling covers a 2 MB base64 screenshot (~2.7 MB) plus the text fields.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * POST /api/feedback/submit — customer incident report (SC-70 port).
 *
 * Auth-gated (all tenant roles): unlike the legacy public /api/feedback, this
 * endpoint requires a session, and every identity/tenant value comes from that
 * session — body-supplied identity fields are ignored by the validator.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // Same master kill switch as the legacy capture path.
  if (!resolveFeedbackConfig().enabled) {
    return NextResponse.json({ status: 'error', error: 'feedback_disabled' }, { status: 503 });
  }

  let submitter: ReportSubmitter | null = null;
  try {
    const session = await auth();
    if (session?.user?.id) {
      submitter = {
        userId: String(session.user.id),
        email: session.user.email ?? null,
        name: session.user.name ?? null,
        tenantId: session.user.tenantId ? String(session.user.tenantId) : null,
        tenantSlug: session.user.tenantSlug ? String(session.user.tenantSlug) : null,
      };
    }
  } catch {
    submitter = null;
  }
  if (!submitter) {
    return NextResponse.json({ status: 'error', error: 'unauthorized' }, { status: 401 });
  }

  // Authoritative tenant resolution (session claims, then DB fallback) per the
  // repo rule that authenticated routes resolve tenant context server-side. A
  // TenantContextError (e.g. mid-onboarding, no membership yet) keeps the
  // session-only identity above — a tenantless user can still file a report.
  try {
    const tenantContext = await getTenantContext();
    submitter = {
      ...submitter,
      userId: tenantContext.userId,
      tenantId: tenantContext.tenantId,
      tenantSlug: tenantContext.tenantSlug,
    };
  } catch {
    // keep session-only identity
  }

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

  const validation = validateReportRequest(body);
  if (!validation.ok) {
    return NextResponse.json(
      { status: 'error', error: validation.error, fieldErrors: validation.fieldErrors },
      { status: 422 },
    );
  }

  const result = await submitFeedbackReport(
    validation.value,
    submitter,
    resolveFeedbackReportConfig(),
  );
  return NextResponse.json(result.body, { status: result.httpStatus });
}
