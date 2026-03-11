import { normalizePublishDispatch } from '../../../../backend/integrations/workflow-orchestrator';

export async function POST(req: Request) {
  let body: { tenant_id?: string; provider?: string; content?: string; media_urls?: string[]; scheduled_for?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const event = normalizePublishDispatch({
      tenant_id: body.tenant_id || 'tenant_demo_001',
      provider: String(body.provider || '').toLowerCase(),
      content: body.content || '',
      media_urls: body.media_urls || [],
      scheduled_for: body.scheduled_for
    });

    return new Response(JSON.stringify({ status: 'ok', dispatched_to: 'n8n/publish-dispatch.workflow.json', event }), {
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
