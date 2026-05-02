import { buildCalendarSyncEvent } from '../../../../backend/integrations/workflow-orchestrator';
import { mapAriesExecutionError, runAriesWorkflow } from '../../../../backend/execution';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleCalendarSync(req: Request, tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: { tenant_id?: string; window_start?: string; window_end?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const event = buildCalendarSyncEvent({
      tenant_id: tenantResult.tenantContext.tenantId,
      window_start: body.window_start,
      window_end: body.window_end
    });
    const executed = await runAriesWorkflow('calendar_sync', {
      tenant_id: tenantResult.tenantContext.tenantId,
      window_start: body.window_start || null,
      window_end: body.window_end || null,
    });
    if (executed.kind === 'gateway_error') {
      const mapped = mapAriesExecutionError(executed.error);
      if (!mapped) {
        return new Response(JSON.stringify({ status: 'error', reason: 'Execution failed.' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
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
      workflow_id: 'calendar_sync',
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
