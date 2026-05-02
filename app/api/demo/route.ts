import { buildPayload, successResponse, errorResponse } from '../../../lib/api-service';
import { mapAriesExecutionError, runAriesWorkflow } from '../../../backend/execution';

/**
 * POST /api/demo
 *
 * Demo / Get Started handler. Delegates to the external OpenClaw workflow
 * boundary.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const user = (body.user as Record<string, string>) || {};

  if (!user.name || !user.email) {
    return errorResponse(400, 'Missing required fields: user.name, user.email');
  }

  const payload = buildPayload({
    surface: 'marketing-site',
    user,
    details: (body.details as Record<string, string>) || {},
  } as any);

  const executed = await runAriesWorkflow('demo_start', {
    source: payload.source,
    surface: payload.surface,
    user: payload.user,
    details: payload.details ?? {},
  });
  if (executed.kind === 'gateway_error') {
    const mapped = mapAriesExecutionError(executed.error);
    if (!mapped) {
      return errorResponse(500, 'Execution failed.');
    }
    return new Response(JSON.stringify(mapped.body), {
      status: mapped.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (executed.kind === 'not_implemented') {
    return errorResponse(501, 'Demo provisioning is not implemented in this OpenClaw runtime.', {
      wired: false,
      reason: executed.payload.code,
      route: executed.payload.route,
    });
  }

  return successResponse({
    provisioned: true,
    workflow_status: executed.envelope.status,
    workflow_response: executed.primaryOutput,
  });
}
