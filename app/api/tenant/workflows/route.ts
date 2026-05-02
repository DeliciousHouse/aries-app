import { ARIES_WORKFLOWS } from '@/backend/execution/workflow-catalog';
import { getTenantContext } from '@/lib/tenant-context';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET() {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  const workflows = Object.values(ARIES_WORKFLOWS).map((workflow) => ({
    id: workflow.key,
    tenant_id: tenantContext.tenantId,
    type: workflow.mode === 'real' ? 'openclaw' : 'openclaw_stub',
    pipeline: workflow.pipeline,
    route: workflow.route,
    mode: workflow.mode,
  }));

  return json({ workflows });
}
