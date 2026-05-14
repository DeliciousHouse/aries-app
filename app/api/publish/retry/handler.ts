import { buildRetryEvent } from '../../../../backend/integrations/workflow-orchestrator';
import { mapAriesExecutionError, runAriesWorkflow } from '../../../../backend/execution';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { handlePublishDispatch, type PublishDispatchHandlerOptions } from '../dispatch/handler';

type PublishRetryBody = {
  tenant_id?: string;
  max_attempts?: number;
  provider?: string;
  content?: string;
  media_urls?: string[];
  scheduled_for?: string;
  marketing_job_id?: string;
  job_id?: string;
};

async function readBody(req: Request): Promise<PublishRetryBody> {
  try {
    return (await req.json()) as PublishRetryBody;
  } catch {
    return {};
  }
}

export async function handlePublishRetry(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  options: PublishDispatchHandlerOptions = {},
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const body = await readBody(req);

  try {
    const tenantId = tenantResult.tenantContext.tenantId;
    const event = buildRetryEvent({ tenant_id: tenantId, max_attempts: body.max_attempts });

    const hasExplicitRetryPayload =
      typeof body.provider === 'string'
      && body.provider.trim().length > 0
      && (typeof body.content === 'string' || Array.isArray(body.media_urls));

    if (hasExplicitRetryPayload) {
      if (typeof body.scheduled_for === 'string' && body.scheduled_for.trim().length > 0) {
        return new Response(JSON.stringify({
          status: 'error',
          reason: 'scheduled_retry_not_safe',
          message: 'Retrying a scheduled publish request can duplicate queued posts. Reschedule or re-dispatch intentionally instead.',
        }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }

      const retryRequest = new Request(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: body.provider,
          content: body.content,
          media_urls: body.media_urls,
          marketing_job_id: body.marketing_job_id,
          job_id: body.job_id,
        }),
      });
      return handlePublishDispatch(retryRequest, tenantContextLoader, options);
    }

    const executed = await runAriesWorkflow('publish_retry', {
      tenant_id: tenantId,
      max_attempts: event.payload.max_attempts,
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
      workflow_id: 'publish_retry',
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
