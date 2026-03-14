import { buildPayload, errorResponse } from '../../../lib/api-service';

/**
 * POST /api/waitlist
 *
 * Waitlist/newsletter sign-up handler.
 * No n8n waitlist workflow exists — logs server-side and returns success.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const user = (body.user as Record<string, string>) || {};

  if (!user.email) {
    return errorResponse(400, 'Missing required field: user.email');
  }

  const payload = buildPayload({
    page: (body.page as string) || '/',
    surface: 'marketing-site',
    user,
  } as any);

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    service: 'aries-api',
    event: 'waitlist_signup',
    wired: false,
    reason: 'no_n8n_waitlist_workflow',
    payload,
  }));

  return errorResponse(501, 'Waitlist signups are not implemented in this runtime.', {
    wired: false,
    reason: 'no_n8n_waitlist_workflow',
    logged: true,
  });
}
