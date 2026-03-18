import { errorResponse } from '../../../lib/api-service';

/**
 * POST /api/events
 *
 * CTA and event tracking endpoint.
 * No repo-managed event-tracking workflow exists yet, so this logs
 * server-side and returns an explicit placeholder error.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const intent = body.intent as string;
  const page = body.page as string;

  if (!intent) {
    return errorResponse(400, 'Missing required field: intent');
  }

  const event = {
    source: 'aries-ai-website',
    surface: (body.surface as string) || 'marketing-site',
    page: page || '/',
    intent,
    timestamp: new Date().toISOString(),
    meta: body.meta || {},
  };

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    service: 'aries-api',
    event: 'frontend_event',
    wired: false,
    reason: 'no_event_workflow',
    payload: event,
  }));

  return errorResponse(501, 'Event tracking is not implemented in this runtime.', {
    wired: false,
    reason: 'no_event_workflow',
    logged: true,
  });
}
