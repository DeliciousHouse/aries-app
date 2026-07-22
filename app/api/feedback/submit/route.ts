import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { getTenantContext } from '@/lib/tenant-context';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';
import { OVER_LIMIT, readBodyCapped } from '@/lib/http/read-body-capped';
import { resolveFeedbackReportConfig } from '@/backend/feedback/report-config';
import { resolveReportSubmitter } from '@/backend/feedback/report-submitter';
import { validateReportRequest } from '@/backend/feedback/report-validation';
import { submitFeedbackReport } from '@/backend/feedback/submit-report';

// Touches pg + node:crypto + next-auth — must run on the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ceiling covers a 2 MB base64 screenshot (~2.7 MB) plus the text fields.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * POST /api/feedback/submit — customer incident report (SC-70 port).
 *
 * Public by product decision: authenticated sessions retain server-resolved
 * user/tenant attribution; missing or expired sessions receive an anonymous,
 * IP-hashed rate-limit identity. Body-supplied identity fields are ignored.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // Same master kill switch as the legacy capture path.
  if (!resolveFeedbackConfig().enabled) {
    return NextResponse.json({ status: 'error', error: 'feedback_disabled' }, { status: 503 });
  }

  const submitter = await resolveReportSubmitter(req.headers, {
    readSession: auth,
    readTenantContext: getTenantContext,
  });

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
