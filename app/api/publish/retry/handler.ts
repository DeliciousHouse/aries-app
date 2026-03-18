import { buildRetryEvent } from '../../../../backend/integrations/workflow-orchestrator';
import { mapOpenClawGatewayError, runAriesOpenClawWorkflow } from '../../../../backend/openclaw/aries-execution';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handlePublishRetry(req: Request, tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: { tenant_id?: string; max_attempts?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const event = buildRetryEvent({ tenant_id: tenantResult.tenantContext.tenantId, max_attempts: body.max_attempts });
    const executed = await runAriesOpenClawWorkflow('publish_retry', {
      tenant_id: tenantResult.tenantContext.tenantId,
      max_attempts: event.payload.max_attempts,
    });
    if (executed.kind === 'gateway_error') {
      const mapped = mapOpenClawGatewayError(executed.error);
      return new Response(JSON.stringify(mapped.body), {
        status: mapped.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (executed.kind === 'not_implemented') {
      return new Response(JSON.stringify({
        status: 'error',
        reason: executed.payload.code,
        route: executed.payload.route,
        message: executed.payload.message,
      }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      status: 'accepted',
      workflow_id: 'publish_retry',
      workflow_status: executed.envelope.status,
      event,
      result: executed.primaryOutput,
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 'error', reason: String((error as Error).message || error) }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
}
