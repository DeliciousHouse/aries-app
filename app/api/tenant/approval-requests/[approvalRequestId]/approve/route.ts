import { getTenantContext } from '@/lib/tenant-context';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(_: Request, context: { params: Promise<{ approvalRequestId: string }> }) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const { approvalRequestId } = await context.params;
  return json({
    status: 'error',
    reason: 'workflow_approval_not_supported',
    message: 'Workflow approval resolution is not implemented in Aries; approvals must be handled by OpenClaw.',
    approvalRequestId,
  }, 501);
}
