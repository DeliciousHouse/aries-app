import { mapAriesExecutionError, runAriesWorkflow } from '@/backend/execution';
import { ARIES_WORKFLOWS, type AriesWorkflowKey } from '@/backend/execution/workflow-catalog';
import { getTenantContext } from '@/lib/tenant-context';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(req: Request, context: { params: Promise<{ workflowId: string }> }) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  const { workflowId } = await context.params;

  let payload: { inputs?: Record<string, unknown>; idempotencyKey?: string } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  if (!(workflowId in ARIES_WORKFLOWS)) {
    return json({ error: 'not_found' }, 404);
  }
  const key = workflowId as AriesWorkflowKey;

  const executed = await runAriesWorkflow(key, {
    tenant_id: tenantContext.tenantId,
    actor_id: tenantContext.userId,
    inputs: payload.inputs || {},
    idempotency_key: payload.idempotencyKey || null,
  }).catch((error) => ({ kind: 'gateway_error' as const, error }));

  if (executed.kind === 'gateway_error') {
    const mapped = mapAriesExecutionError(executed.error);
    if (!mapped) {
      return json({ error: 'Execution failed.' }, 500);
    }
    return json(mapped.body, mapped.status);
  }
  if (executed.kind === 'not_implemented') {
    return json({
      status: 'error',
      reason: executed.payload.code,
      route: executed.payload.route,
      message: executed.payload.message,
    }, 501);
  }

  return json({
    status: 'accepted',
    workflow_id: workflowId,
    workflow_status: executed.envelope.status,
    result: executed.primaryOutput,
  }, 202);
}
