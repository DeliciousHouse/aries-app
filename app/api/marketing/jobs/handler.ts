import { NextResponse } from 'next/server';

import { startMarketingJob } from '@/backend/marketing/orchestrator';
import { OpenClawGatewayError } from '@/backend/openclaw/gateway-client';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before starting a brand campaign.',
} as const;

function marketingStatusPublic(): boolean {
  const raw = process.env.MARKETING_STATUS_PUBLIC?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function derivePublicMarketingTenantId(payload: Record<string, unknown>): string {
  const brandUrl = typeof payload.brandUrl === 'string' ? payload.brandUrl.trim() : '';
  if (!brandUrl) {
    return 'public_campaign';
  }

  try {
    const hostname = new URL(brandUrl).hostname.trim().toLowerCase();
    const slug = hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `public_${slug}` : 'public_campaign';
  } catch {
    const slug = brandUrl.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `public_${slug}` : 'public_campaign';
  }
}

export async function handlePostMarketingJobs(
  req: Request,
  tenantContextLoader?: TenantContextLoader
) {
  let payload: { jobType?: unknown; payload?: Record<string, unknown> } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  const resolvedTenantId =
    'response' in tenantResult
      ? marketingStatusPublic() && payload.payload
        ? derivePublicMarketingTenantId(payload.payload)
        : null
      : tenantResult.tenantContext.tenantId;

  if (!resolvedTenantId) {
    if ('response' in tenantResult) {
      return tenantResult.response;
    }
    return NextResponse.json(
      {
        status: 'error',
        reason: 'tenant_context_required',
        message: 'Authentication required.',
      },
      { status: 403 }
    );
  }

  try {
    const result = await startMarketingJob({
      tenantId: resolvedTenantId,
      jobType: payload.jobType as 'brand_campaign',
      payload: payload.payload ?? {},
    });

    return NextResponse.json(
      {
        marketing_job_status: result.status,
        jobId: result.jobId,
        jobType: result.jobType,
        marketing_stage: result.currentStage,
        approvalRequired: result.approvalRequired,
        approval: result.approval,
        jobStatusUrl: `/marketing/job-status?jobId=${encodeURIComponent(result.jobId)}`,
      },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof OpenClawGatewayError) {
      const status =
        error.code === 'openclaw_gateway_unauthorized'
          ? 401
          : error.code === 'openclaw_gateway_unreachable' || error.code === 'openclaw_gateway_not_configured'
            ? 503
            : error.status || 500;
      return NextResponse.json({ error: message, reason: error.code }, { status });
    }
    if (message.startsWith('workflow_missing_for_route:')) {
      return NextResponse.json({ error: message, reason: 'workflow_missing_for_route' }, { status: 501 });
    }
    if (message.startsWith('missing_required_fields:') || message.startsWith('unsupported_job_type:')) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}
