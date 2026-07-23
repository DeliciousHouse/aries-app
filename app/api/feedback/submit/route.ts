import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { getTenantContext, WorkspaceMismatchError } from '@/lib/tenant-context';
import { workspaceMismatchResponse } from '@/lib/tenant-context-http';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';
import { OVER_LIMIT, readBodyCapped } from '@/lib/http/read-body-capped';
import { resolveFeedbackReportConfig } from '@/backend/feedback/report-config';
import {
  ReportTenantAttributionError,
  resolveReportSubmitter,
} from '@/backend/feedback/report-submitter';
import { validateReportRequest } from '@/backend/feedback/report-validation';
import { submitFeedbackReport } from '@/backend/feedback/submit-report';

// Touches pg + node:crypto + next-auth — must run on the Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ceiling covers a 2 MB base64 screenshot (~2.7 MB) plus the text fields.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface FeedbackSubmitRouteDeps {
  enabled?: () => boolean;
  resolveSubmitter?: typeof resolveReportSubmitter;
}

/**
 * POST /api/feedback/submit — customer incident report (SC-70 port).
 *
 * Public by product decision: authenticated sessions retain server-resolved
 * user/tenant attribution; missing or expired sessions receive an anonymous,
 * IP-hashed rate-limit identity. Body-supplied identity fields are ignored.
 */
export async function handleFeedbackSubmit(
  req: Request,
  deps: FeedbackSubmitRouteDeps = {},
): Promise<Response> {
  // Same master kill switch as the legacy capture path.
  if (!(deps.enabled ?? (() => resolveFeedbackConfig().enabled))()) {
    return NextResponse.json({ status: 'error', error: 'feedback_disabled' }, { status: 503 });
  }

  let submitter;
  try {
    const attributionDeps = {
      readSession: auth,
      readTenantContext: () => getTenantContext({ requireLiveMembership: true }),
    };
    submitter = deps.resolveSubmitter
      ? await deps.resolveSubmitter(req.headers, attributionDeps)
      : await resolveReportSubmitter(req.headers, attributionDeps);
  } catch (error) {
    const cause = error instanceof ReportTenantAttributionError ? error.cause : undefined;
    if (cause instanceof WorkspaceMismatchError) {
      const response = workspaceMismatchResponse(cause);
      if (response) return response;
    }
    if (error instanceof ReportTenantAttributionError) {
      if (cause === undefined) {
        return NextResponse.json(
          {
            status: 'error',
            reason: 'workspace_mismatch',
            code: 'workspace_mismatch',
            message: 'Your current workspace membership changed. Refresh and retry.',
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          status: 'error',
          error: 'tenant_context_unavailable',
          message: 'We could not verify your workspace right now. Please retry.',
        },
        { status: 503 },
      );
    }
    throw error;
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

export async function POST(req: Request): Promise<Response> {
  return handleFeedbackSubmit(req);
}
