/**
 * Internal endpoint that starts a weekly_social_content job for one tenant.
 *
 * Driven by scripts/automations/weekly-job-trigger-worker.ts, which owns the
 * cadence/claim logic and POSTs one tenant at a time. Kept inside the app
 * process (not the worker) because starting a job submits to Hermes and writes
 * runtime artifacts under DATA_ROOT — the route-handler boundary owns that, the
 * same way the scheduled-posts-worker delegates publishing to
 * /api/internal/publishing/scheduled-dispatch.
 *
 * Auth: INTERNAL_API_SECRET bearer (verifyInternalCallbackRequest), never a
 * browser session. The worker hits this over the in-network http://aries-app:3000.
 */
import { verifyInternalCallbackRequest } from '@/lib/internal-callback-auth';
import { triggerWeeklyJobForTenant } from '@/backend/marketing/weekly-trigger';

type WeeklyTriggerBody = {
  tenant_id?: string;
  tenantId?: string;
};

async function readBody(req: Request): Promise<WeeklyTriggerBody> {
  try {
    return (await req.json()) as WeeklyTriggerBody;
  } catch {
    return {};
  }
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: Request): Promise<Response> {
  const authResult = verifyInternalCallbackRequest(req);
  if (!authResult.ok) {
    return json({ error: authResult.reason }, authResult.status);
  }

  const body = await readBody(req);
  const raw = body.tenant_id ?? body.tenantId;
  const tenantId = typeof raw === 'string' ? raw.trim() : '';
  if (!tenantId) {
    return json({ error: 'missing_tenant_id' }, 400);
  }

  const result = await triggerWeeklyJobForTenant(tenantId);

  // Map the trigger result to an HTTP status the worker can branch on:
  //   error  → 500 so the worker reverts its claim and retries next tick.
  //   others → 200; the worker keeps the claim (no retry until next window) and
  //            logs/alerts on skips and needs_connection.
  const status = result.status === 'error' ? 500 : 200;
  return json({ tenant_id: tenantId, ...result }, status);
}
