import { buildPayload, postToN8n, successResponse, errorResponse } from '../../../../lib/api-service';

/**
 * POST /api/sandbox/launch
 *
 * Sandbox launch handler. Proxies to the real tenant-provisioning
 * n8n webhook with tenant_type=sandbox.
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
    surface: 'marketing-site',
    user,
    details: (body.details as Record<string, string>) || {},
  } as any);

  const sandboxId = `sandbox_${Date.now()}`;

  const result = await postToN8n('tenant-provisioning', {
    tenant_id: sandboxId,
    tenant_type: 'sandbox',
    signup_event_id: `evt_sandbox_${Date.now()}`,
    metadata: {
      source: payload.source,
      surface: payload.surface,
      user: payload.user,
    },
  });

  if (!result.ok) {
    return errorResponse(result.status, 'Sandbox provisioning failed', {
      webhookPath: result.webhookPath,
      durationMs: result.durationMs,
    });
  }

  return successResponse({
    sandbox_id: sandboxId,
    tenant_type: 'sandbox',
    provisioned: true,
    webhookPath: result.webhookPath,
    durationMs: result.durationMs,
    workflow_response: result.data,
  });
}
