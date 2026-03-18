import { normalizePublishDispatch } from '../../../../backend/integrations/workflow-orchestrator';
import { mapOpenClawGatewayError, runAriesOpenClawWorkflow } from '../../../../backend/openclaw/aries-execution';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handlePublishDispatch(req: Request, tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: { tenant_id?: string; provider?: string; content?: string; media_urls?: string[]; scheduled_for?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const tenantId = tenantResult.tenantContext.tenantId;
    const event = normalizePublishDispatch({
      tenant_id: tenantId,
      provider: String(body.provider || '').toLowerCase(),
      content: body.content || '',
      media_urls: body.media_urls || [],
      scheduled_for: body.scheduled_for,
    });
    const executed = await runAriesOpenClawWorkflow('publish_dispatch', {
      tenant_id: tenantId,
      provider: event.provider,
      content_text: event.payload.content_text || '',
      media_urls: event.payload.media_urls || [],
      scheduled_for: event.payload.scheduled_for || null,
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
      workflow_id: 'publish_dispatch',
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
      headers: { 'content-type': 'application/json' },
    });
  }
}
