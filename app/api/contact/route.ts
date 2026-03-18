import { NextResponse } from 'next/server';
import { buildPayload, successResponse, errorResponse } from '../../../lib/api-service';

/**
 * POST /api/contact
 *
 * Contact form handler. No repo-managed contact workflow exists yet, so this
 * logs the submission server-side and returns an explicit placeholder error.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const user = (body.user as Record<string, string>) || {};
  const details = (body.details as Record<string, string>) || {};

  if (!user.name || !user.email) {
    return errorResponse(400, 'Missing required fields: user.name, user.email');
  }

  if (!details.message || (details.message as string).length < 10) {
    return errorResponse(400, 'Message must be at least 10 characters');
  }

  const payload = buildPayload({
    surface: 'marketing-site',
    user,
    details,
  } as any); // Type assertion to bypass string literal reqs for now

  // Log server-side (no repo-managed workflow yet)
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    service: 'aries-api',
    event: 'contact_submission',
    wired: false,
    reason: 'no_contact_workflow',
    payload,
  }));

  return errorResponse(501, 'Contact submissions are not implemented in this runtime.', {
    wired: false,
    reason: 'no_contact_workflow',
    logged: true,
  });
}
