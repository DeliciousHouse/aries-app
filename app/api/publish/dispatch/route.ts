import { normalizePublishDispatch } from '../../../../backend/integrations/workflow-orchestrator';
import { errorResponse, postToN8n } from '../../../../lib/api-service';

const PUBLISH_WEBHOOK_PATH = 'aries/publish';

export async function POST(req: Request) {
  let body: { tenant_id?: string; provider?: string; content?: string; media_urls?: string[]; scheduled_for?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const event = normalizePublishDispatch({
      tenant_id: body.tenant_id || '',
      provider: String(body.provider || '').toLowerCase(),
      content: body.content || '',
      media_urls: body.media_urls || [],
      scheduled_for: body.scheduled_for
    });

    const result = await postToN8n(PUBLISH_WEBHOOK_PATH, event);

    if (!result.ok) {
      return errorResponse(result.status, 'Publish dispatch failed.', {
        dispatched: false,
        webhookPath: PUBLISH_WEBHOOK_PATH,
        downstreamStatus: result.status,
        downstream: result.data,
      });
    }

    return new Response(JSON.stringify({
      status: 'accepted',
      dispatched: true,
      webhookPath: PUBLISH_WEBHOOK_PATH,
      downstreamStatus: result.status,
      event,
    }), {
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
