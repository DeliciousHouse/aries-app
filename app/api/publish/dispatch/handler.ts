import { normalizePublishDispatch } from '../../../../backend/integrations/workflow-orchestrator';
import { mapAriesExecutionError, runAriesWorkflow } from '../../../../backend/execution';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { assertMediaUrlsBelongToTenant } from '../../../../backend/integrations/media-url-ownership';
import { runPublishVerification } from '../../../../backend/integrations/publish-verification';
import { schedulePublishVerificationHonchoWrite } from '@/backend/memory/write-events';
import {
  isMetaProvider,
  MetaPublishError,
  persistScheduledPublishRecord,
  publishToMetaGraph,
  type MetaPublishSuccess,
} from '../../../../backend/integrations/meta-publishing';
import {
  findLatestMarketingApprovalRecord,
  loadMarketingApprovalRecord,
  MarketingApprovalLockError,
  withMarketingApprovalLock,
  saveMarketingApprovalRecord,
} from '../../../../backend/marketing/approval-store';
import { pool } from '@/lib/db';

type PublishDispatchBody = {
  tenant_id?: string;
  provider?: string;
  content?: string;
  media_urls?: string[];
  scheduled_for?: string;
  marketing_job_id?: string;
  job_id?: string;
  /** Explicit approval record id. Required for Meta/Instagram publishes. */
  approval_id?: string;
};

export type PublishDispatchHandlerOptions = {
  publishExecutor?: (request: {
    tenantId: string;
    provider: string;
    content: string;
    mediaUrls: string[];
    scheduledFor?: string | null;
  }) => Promise<MetaPublishSuccess>;
};

async function readBody(req: Request): Promise<PublishDispatchBody> {
  try {
    return (await req.json()) as PublishDispatchBody;
  } catch {
    return {};
  }
}

function parseMarketingJobId(body: PublishDispatchBody): string | undefined {
  const marketingJobIdRaw = typeof body.marketing_job_id === 'string' ? body.marketing_job_id.trim() : '';
  return marketingJobIdRaw.length > 0 ? marketingJobIdRaw : undefined;
}

function maybeMirrorPublishedResult(args: {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  role: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';
  marketingJobId?: string;
  provider: string;
  verification: Awaited<ReturnType<typeof runPublishVerification>>;
}): void {
  if (args.verification.status !== 'published' || !args.marketingJobId || !args.verification.publishedAt) {
    return;
  }
  const publishedYmd = args.verification.publishedAt.slice(0, 10).replace(/-/g, '');
  schedulePublishVerificationHonchoWrite({
    tenantCtx: {
      tenantId: args.tenantId,
      tenantSlug: args.tenantSlug,
      userId: args.userId,
      role: args.role,
    },
    jobId: args.marketingJobId,
    platform: args.provider.toLowerCase(),
    publishedAtYmd: publishedYmd,
  });
}

/**
 * Atomically validates and consumes a marketing_approval_record before any
 * Graph API side-effect. Uses withMarketingApprovalLock for mutual exclusion.
 *
 * Returns null on success (approval consumed). Returns a Response on failure
 * (caller should return that response immediately).
 */
async function validateAndConsumeApproval(args: {
  tenantId: string;
  marketingJobId: string | undefined;
  approvalId: string | undefined;
}): Promise<Response | null> {
  // Resolve the approval record: by explicit id first, then by job+stage
  let approvalId: string | undefined = args.approvalId?.trim() || undefined;

  if (!approvalId) {
    if (!args.marketingJobId) {
      return new Response(
        JSON.stringify({
          status: 'error',
          reason: 'publish_requires_approval',
          message: 'Meta/Instagram publish requires an approval_id or marketing_job_id.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    // Derive from job+stage
    const record = findLatestMarketingApprovalRecord({
      marketingJobId: args.marketingJobId,
      tenantId: args.tenantId,
      marketingStage: 'publish',
      statuses: ['approved'],
    });
    if (!record) {
      return new Response(
        JSON.stringify({
          status: 'error',
          reason: 'publish_requires_approval',
          message: 'No approved marketing_approval_record found for this publish event.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    approvalId = record.approval_id;
  }

  // Atomically consume inside the file lock
  let consumeError: Response | null = null;
  try {
    await withMarketingApprovalLock(approvalId, async () => {
      const record = loadMarketingApprovalRecord(approvalId as string);
      if (!record) {
        consumeError = new Response(
          JSON.stringify({
            status: 'error',
            reason: 'publish_requires_approval',
            message: `marketing_approval_record ${approvalId} not found.`,
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      if (record.tenant_id !== args.tenantId) {
        consumeError = new Response(
          JSON.stringify({
            status: 'error',
            reason: 'publish_requires_approval',
            message: 'Approval record does not belong to this tenant.',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      if (record.status === 'consumed') {
        consumeError = new Response(
          JSON.stringify({
            status: 'error',
            reason: 'publish_approval_already_consumed',
            message: `Approval ${approvalId} has already been consumed; cannot publish again.`,
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      if (record.status !== 'approved') {
        consumeError = new Response(
          JSON.stringify({
            status: 'error',
            reason: 'publish_requires_approval',
            message: `Approval ${approvalId} is in status '${record.status}', not 'approved'.`,
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      // Mark consumed atomically inside the lock
      record.status = 'consumed';
      record.resolved_at = new Date().toISOString();
      saveMarketingApprovalRecord(record);
    });
  } catch (error) {
    if (error instanceof MarketingApprovalLockError) {
      return new Response(
        JSON.stringify({
          status: 'error',
          reason: 'publish_approval_already_consumed',
          message: 'Approval is currently being processed by another request.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    throw error;
  }

  return consumeError;
}

export async function handlePublishDispatch(
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
    const mediaUrls = body.media_urls || [];

    try {
      await assertMediaUrlsBelongToTenant(tenantId, mediaUrls, pool);
    } catch (error) {
      const message = String((error as Error).message || error);
      const urlMatch = message.match(/media_url_tenant_mismatch:(.+)/);
      const offendingUrl = urlMatch ? urlMatch[1] : mediaUrls[0] || 'unknown';
      return new Response(JSON.stringify({ error: 'media_url_tenant_mismatch', detail: { url: offendingUrl } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    const marketingJobId = parseMarketingJobId(body);
    const provider = String(body.provider || '').toLowerCase();
    const event = normalizePublishDispatch({
      tenant_id: tenantId,
      provider,
      content: body.content || '',
      media_urls: mediaUrls,
      scheduled_for: body.scheduled_for,
      marketing_job_id: marketingJobId,
    });

    if (isMetaProvider(provider)) {
      // BLOCKER 1: Enforce approval gate before any Graph API side-effect
      const approvalError = await validateAndConsumeApproval({
        tenantId,
        marketingJobId,
        approvalId: typeof body.approval_id === 'string' ? body.approval_id : undefined,
      });
      if (approvalError) {
        return approvalError;
      }

      const publishExecutor = options.publishExecutor ?? ((request) => publishToMetaGraph(request));
      const published = await publishExecutor({
        tenantId,
        provider,
        content: String(event.payload.content_text || body.content || ''),
        mediaUrls: Array.isArray(event.payload.media_urls) ? event.payload.media_urls as string[] : mediaUrls,
        scheduledFor: typeof event.payload.scheduled_for === 'string' ? event.payload.scheduled_for : null,
      });

      if (published.mode === 'scheduled' && published.scheduledFor) {
        const persisted = await persistScheduledPublishRecord({
          tenantId,
          content: String(event.payload.content_text || body.content || ''),
          platformPostId: published.platformPostId,
          scheduledFor: published.scheduledFor,
          db: pool,
        });

        return new Response(JSON.stringify({
          status: 'accepted',
          workflow_id: 'publish_dispatch',
          workflow_status: 'scheduled',
          event,
          result: {
            provider: published.provider,
            mode: published.mode,
            connection_id: published.connectionId,
            platform_post_id: published.platformPostId,
            scheduled_for: published.scheduledFor,
          },
          publish_verification: {
            status: 'scheduled',
            platformPostId: published.platformPostId,
            postId: persisted.postId,
            reason: null,
            publishedAt: null,
            scheduledFor: published.scheduledFor,
          },
        }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }

      const verification = await runPublishVerification({
        tenantId,
        provider: published.provider,
        content: String(event.payload.content_text || body.content || ''),
        primaryOutput: { platform_post_id: published.platformPostId },
        pool,
      });

      maybeMirrorPublishedResult({
        tenantId,
        tenantSlug: tenantResult.tenantContext.tenantSlug,
        userId: tenantResult.tenantContext.userId,
        role: tenantResult.tenantContext.role,
        marketingJobId,
        provider: published.provider,
        verification,
      });

      return new Response(JSON.stringify({
        status: 'accepted',
        workflow_id: 'publish_dispatch',
        workflow_status: 'completed',
        event,
        result: {
          provider: published.provider,
          mode: published.mode,
          connection_id: published.connectionId,
          platform_post_id: published.platformPostId,
        },
        publish_verification: verification,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }

    const executed = await runAriesWorkflow('publish_dispatch', {
      tenant_id: tenantId,
      provider: event.provider,
      content_text: event.payload.content_text || '',
      media_urls: event.payload.media_urls || [],
      scheduled_for: event.payload.scheduled_for || null,
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

    let verification = null as null | Awaited<ReturnType<typeof runPublishVerification>>;
    try {
      verification = await runPublishVerification({
        tenantId,
        provider: event.provider ?? '',
        content: typeof event.payload.content_text === 'string' ? event.payload.content_text : body.content || '',
        primaryOutput: executed.primaryOutput,
        pool,
      });
    } catch (verificationError) {
      verification = {
        status: 'unverified',
        platformPostId: null,
        postId: null,
        reason: 'persistence_error',
        publishedAt: null,
      };
      console.error('[publish-dispatch] verification step failed', {
        tenantId,
        provider: event.provider,
        error: String((verificationError as Error).message || verificationError),
      });
    }

    if (verification) {
      maybeMirrorPublishedResult({
        tenantId,
        tenantSlug: tenantResult.tenantContext.tenantSlug,
        userId: tenantResult.tenantContext.userId,
        role: tenantResult.tenantContext.role,
        marketingJobId,
        provider: String(event.provider ?? body.provider ?? '').toLowerCase(),
        verification,
      });
    }

    return new Response(JSON.stringify({
      status: 'accepted',
      workflow_id: 'publish_dispatch',
      workflow_status: executed.envelope.status,
      event,
      result: executed.primaryOutput,
      publish_verification: verification,
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof MetaPublishError) {
      return new Response(JSON.stringify({ status: 'error', reason: error.code, message: error.message }), {
        status: error.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ status: 'error', reason: String((error as Error).message || error) }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
}
