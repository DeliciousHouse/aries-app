import { NextResponse } from 'next/server';

import { startMarketingJob } from '@/backend/marketing/orchestrator';
import {
  ensureCampaignWorkspaceRecord,
  saveCampaignWorkspaceAssets,
  type CampaignWorkspaceAssetUpload,
} from '@/backend/marketing/workspace-store';
import { OpenClawGatewayError } from '@/backend/openclaw/gateway-client';
import {
  marketingPayloadDefaultsFromBusinessProfile,
  persistBusinessProfileFieldsFromMarketingPayload,
} from '@/backend/tenant/business-profile';
import { normalizeMarketingWebsiteUrl } from '@/lib/marketing-public-mode';
import {
  COMPETITOR_URL_INVALID_ERROR,
  COMPETITOR_URL_SOCIAL_ERROR,
  normalizeMetaLocatorUrl,
  normalizeMetaPageId,
  validateCanonicalCompetitorUrl,
} from '@/lib/marketing-competitor';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before starting a brand campaign.',
} as const;

function coerceFieldValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseStringListField(entries: FormDataEntryValue[]): string[] {
  const fromEntries = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (fromEntries.length > 1) {
    return fromEntries;
  }

  const raw = fromEntries[0];
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim());
    }
  } catch {}

  return raw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeJobPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const nextPayload = { ...payload };
  const normalizedBrandUrl = normalizeMarketingWebsiteUrl(
    typeof payload.brandUrl === 'string'
      ? payload.brandUrl
      : typeof payload.websiteUrl === 'string'
        ? payload.websiteUrl
        : null,
  );
  if (normalizedBrandUrl) {
    nextPayload.brandUrl = normalizedBrandUrl;
    nextPayload.websiteUrl = normalizedBrandUrl;
  }

  const competitorValidation = validateCanonicalCompetitorUrl(
    typeof payload.competitorUrl === 'string' ? payload.competitorUrl : null,
  );
  if (competitorValidation.error) {
    throw new Error(competitorValidation.error);
  }
  if (competitorValidation.normalized) {
    nextPayload.competitorUrl = competitorValidation.normalized;
  } else if (typeof payload.competitorUrl === 'string' && payload.competitorUrl.trim().length === 0) {
    delete nextPayload.competitorUrl;
  }

  const normalizedCompetitorBrand =
    typeof payload.competitorBrand === 'string' && payload.competitorBrand.trim().length > 0
      ? payload.competitorBrand.trim()
      : null;
  if (normalizedCompetitorBrand) {
    nextPayload.competitorBrand = normalizedCompetitorBrand;
  }

  const normalizedFacebookPageUrl = normalizeMetaLocatorUrl(
    typeof payload.facebookPageUrl === 'string'
      ? payload.facebookPageUrl
      : typeof payload.competitorFacebookUrl === 'string'
        ? payload.competitorFacebookUrl
        : null,
  );
  if (normalizedFacebookPageUrl) {
    nextPayload.facebookPageUrl = normalizedFacebookPageUrl;
    nextPayload.competitorFacebookUrl = normalizedFacebookPageUrl;
  }

  const normalizedAdLibraryUrl = normalizeMetaLocatorUrl(
    typeof payload.adLibraryUrl === 'string' ? payload.adLibraryUrl : null,
  );
  if (normalizedAdLibraryUrl) {
    nextPayload.adLibraryUrl = normalizedAdLibraryUrl;
  }

  const normalizedMetaPageId = normalizeMetaPageId(
    typeof payload.metaPageId === 'string' ? payload.metaPageId : null,
  );
  if (normalizedMetaPageId) {
    nextPayload.metaPageId = normalizedMetaPageId;
  }

  const normalizedPrimaryGoal =
    typeof payload.primaryGoal === 'string'
      ? payload.primaryGoal.trim()
      : typeof payload.goal === 'string'
        ? payload.goal.trim()
        : '';
  if (normalizedPrimaryGoal) {
    nextPayload.primaryGoal = normalizedPrimaryGoal;
    nextPayload.goal = normalizedPrimaryGoal;
  }

  const normalizedApproverName =
    typeof payload.launchApproverName === 'string'
      ? payload.launchApproverName.trim()
      : typeof payload.approverName === 'string'
        ? payload.approverName.trim()
        : '';
  if (normalizedApproverName) {
    nextPayload.launchApproverName = normalizedApproverName;
    nextPayload.approverName = normalizedApproverName;
  }

  return nextPayload;
}

function enrichPayloadFromBusinessProfile(
  tenantId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = marketingPayloadDefaultsFromBusinessProfile(tenantId);
  const nextPayload = { ...payload };
  const applyIfMissing = (key: string, value: unknown) => {
    if (typeof nextPayload[key] === 'string' && nextPayload[key].trim().length > 0) {
      return;
    }
    if (Array.isArray(nextPayload[key]) && nextPayload[key].length > 0) {
      return;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      nextPayload[key] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      nextPayload[key] = value;
    }
  };

  applyIfMissing('websiteUrl', defaults.websiteUrl);
  applyIfMissing('brandUrl', defaults.websiteUrl);
  applyIfMissing('businessName', defaults.businessName);
  applyIfMissing('businessType', defaults.businessType);
  applyIfMissing('primaryGoal', defaults.primaryGoal);
  applyIfMissing('goal', defaults.goal);
  applyIfMissing('launchApproverName', defaults.launchApproverName);
  applyIfMissing('approverName', defaults.approverName);
  applyIfMissing('offer', defaults.offer);
  applyIfMissing('competitorUrl', defaults.competitorUrl);
  applyIfMissing('channels', defaults.channels);
  applyIfMissing('brandVoice', defaults.brandVoice);
  applyIfMissing('styleVibe', defaults.styleVibe);

  return nextPayload;
}

async function parseCreateJobRequest(req: Request): Promise<{
  jobType?: unknown;
  payload: Record<string, unknown>;
  uploads: CampaignWorkspaceAssetUpload[];
}> {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    const uploadEntries = formData.getAll('brandAssets');
    const uploads: CampaignWorkspaceAssetUpload[] = [];

    for (const entry of uploadEntries) {
      if (!(entry instanceof File) || entry.size <= 0) {
        continue;
      }
      uploads.push({
        name: entry.name,
        contentType: entry.type || 'application/octet-stream',
        data: Buffer.from(await entry.arrayBuffer()),
      });
    }

    return {
      jobType: formData.get('jobType'),
      payload: {
        brandUrl: coerceFieldValue(formData.get('brandUrl')) || coerceFieldValue(formData.get('websiteUrl')),
        competitorUrl: coerceFieldValue(formData.get('competitorUrl')),
        competitorBrand: coerceFieldValue(formData.get('competitorBrand')),
        facebookPageUrl:
          coerceFieldValue(formData.get('facebookPageUrl')) || coerceFieldValue(formData.get('competitorFacebookUrl')),
        competitorFacebookUrl: coerceFieldValue(formData.get('competitorFacebookUrl')),
        adLibraryUrl: coerceFieldValue(formData.get('adLibraryUrl')),
        metaPageId: coerceFieldValue(formData.get('metaPageId')),
        businessName: coerceFieldValue(formData.get('businessName')),
        businessType: coerceFieldValue(formData.get('businessType')),
        launchApproverName: coerceFieldValue(formData.get('launchApproverName')) || coerceFieldValue(formData.get('approverName')),
        approverName: coerceFieldValue(formData.get('approverName')),
        brandVoice: coerceFieldValue(formData.get('brandVoice')),
        styleVibe: coerceFieldValue(formData.get('styleVibe')),
        visualReferences: parseStringListField(formData.getAll('visualReferences')),
        mustUseCopy: coerceFieldValue(formData.get('mustUseCopy')),
        mustAvoidAesthetics: coerceFieldValue(formData.get('mustAvoidAesthetics')),
        notes: coerceFieldValue(formData.get('notes')),
        primaryGoal: coerceFieldValue(formData.get('primaryGoal')) || coerceFieldValue(formData.get('goal')),
        goal: coerceFieldValue(formData.get('goal')),
        offer: coerceFieldValue(formData.get('offer')),
        mode: coerceFieldValue(formData.get('mode')),
        channels: parseStringListField(formData.getAll('channels')),
      },
      uploads,
    };
  }

  let payload: { jobType?: unknown; payload?: Record<string, unknown> } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  return {
    jobType: payload.jobType,
    payload: payload.payload ?? {},
    uploads: [],
  };
}

export async function handlePostMarketingJobs(
  req: Request,
  tenantContextLoader?: TenantContextLoader
) {
  const requestBody = await parseCreateJobRequest(req);
  let normalizedPayload: Record<string, unknown>;
  try {
    normalizedPayload = normalizeJobPayload(requestBody.payload ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === COMPETITOR_URL_SOCIAL_ERROR || message === COMPETITOR_URL_INVALID_ERROR) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw error;
  }

  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const resolvedTenantId = tenantResult.tenantContext.tenantId;

  console.info('[marketing-job-create]', {
    event: 'tenant-resolution',
    normalizedBrandUrl: typeof normalizedPayload.brandUrl === 'string' ? normalizedPayload.brandUrl : null,
    tenantId: resolvedTenantId,
  });

  try {
    persistBusinessProfileFieldsFromMarketingPayload({
      tenantId: resolvedTenantId,
      tenantSlug:
        tenantResult.tenantContext.tenantSlug,
      payload: normalizedPayload,
    });
    const hydratedPayload = enrichPayloadFromBusinessProfile(resolvedTenantId, normalizedPayload);
    const result = await startMarketingJob({
      tenantId: resolvedTenantId,
      jobType: requestBody.jobType as 'brand_campaign',
      payload: hydratedPayload,
    });
    const workspace = ensureCampaignWorkspaceRecord({
      jobId: result.jobId,
      tenantId: resolvedTenantId,
      payload: hydratedPayload,
    });
    if (requestBody.uploads.length > 0) {
      saveCampaignWorkspaceAssets(workspace, requestBody.uploads);
    }

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
    if (message.startsWith('brand_kit_')) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    if (
      message.startsWith('missing_required_fields:') ||
      message.startsWith('unsupported_job_type:') ||
      message === COMPETITOR_URL_SOCIAL_ERROR ||
      message === COMPETITOR_URL_INVALID_ERROR
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    console.error('[marketing-job-create] unhandled error', {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}
