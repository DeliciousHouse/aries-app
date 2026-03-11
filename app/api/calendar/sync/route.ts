import { buildCalendarSyncEvent } from '../../../../backend/integrations/workflow-orchestrator';

export async function POST(req: Request) {
  let body: { tenant_id?: string; window_start?: string; window_end?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const event = buildCalendarSyncEvent({
      tenant_id: body.tenant_id || 'tenant_demo_001',
      window_start: body.window_start,
      window_end: body.window_end
    });

    return new Response(JSON.stringify({ status: 'ok', dispatched_to: 'n8n/calendar-schedule-sync.workflow.json', event }), {
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
