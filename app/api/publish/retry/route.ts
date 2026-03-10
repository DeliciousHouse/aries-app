import { buildRetryEvent } from '../../../../../backend/integrations/workflow-orchestrator';

export async function POST(req: Request) {
  let body: { tenant_id?: string; max_attempts?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const event = buildRetryEvent({ tenant_id: body.tenant_id || 'tenant_demo_001', max_attempts: body.max_attempts });
    return new Response(JSON.stringify({ status: 'ok', dispatched_to: 'n8n/publish-retry.workflow.json', event }), {
      status: 202,
      headers: { 'content-type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 'error', reason: String((error as Error).message || error) }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
}
