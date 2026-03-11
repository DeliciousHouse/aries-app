import { buildPayload, postToN8n, successResponse, errorResponse } from '../../../lib/api-service';

/**
 * POST /api/demo
 *
 * Demo / Get Started handler. Proxies to the real tenant-provisioning
 * n8n webhook to create a demo tenant.
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

  // Proxy to tenant-provisioning workflow
  const result = await postToN8n('tenant-provisioning', {
    tenant_id: `demo_${Date.now()}`,
    tenant_type: 'demo',
    signup_event_id: `evt_demo_${Date.now()}`,
    metadata: {
      source: payload.source,
      surface: payload.surface,
      user: payload.user,
    },
  });

  if (!result.ok) {
    return errorResponse(result.status, 'Demo provisioning failed', {
      webhookPath: result.webhookPath,
      durationMs: result.durationMs,
    });
  }

  return successResponse({
    provisioned: true,
    webhookPath: result.webhookPath,
    durationMs: result.durationMs,
    workflow_response: result.data,
  });
}
