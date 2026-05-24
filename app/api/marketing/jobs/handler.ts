import { NextResponse } from 'next/server';

import { mapAriesExecutionError } from '@/backend/execution';
import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { startMarketingJob } from '@/backend/marketing/orchestrator';
import {
  ensureCampaignWorkspaceRecord,
  saveCampaignWorkspaceAssets,
  type CampaignWorkspaceAssetUpload,
} from '@/backend/marketing/workspace-store';
import {
  marketingPayloadDefaultsFromBusinessProfile,
  persistBusinessProfileFieldsFromMarketingPayload,
  loadTenantTimezoneOrFallback,
} from '@/backend/tenant/business-profile';
import { wallTimeToUtc } from '@/lib/format-timestamp';
import { normalizeWeeklySocialContentPayload } from '@/backend/social-content/payload';
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
  message: 'Complete tenant onboarding before starting a marketing job.',
} as const;

type PublicJobType = 'weekly_social_content' | 'event_campaign';
type ResponseDialect = 'marketing' | 'social-content';

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

async function enrichPayloadFromBusinessProfile(
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const defaults = await marketingPayloadDefaultsFromBusinessProfile(tenantId);
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
        launchApproverName:
          coerceFieldValue(formData.get('launchApproverName')) || coerceFieldValue(formData.get('approverName')),
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
        audience: coerceFieldValue(formData.get('audience')),
        mode: coerceFieldValue(formData.get('mode')),
        channels: parseStringListField(formData.getAll('channels')),
        forbiddenVisualPatterns: parseStringListField(formData.getAll('forbiddenVisualPatterns')),
        staticPostCount: coerceFieldValue(formData.get('staticPostCount')),
        imageCreativeCount: coerceFieldValue(formData.get('imageCreativeCount')),
        videoScriptCount: coerceFieldValue(formData.get('videoScriptCount')),
        videoRenderCount: coerceFieldValue(formData.get('videoRenderCount')),
        campaignWindowDays: coerceFieldValue(formData.get('campaignWindowDays')),
        staticPostsCount: coerceFieldValue(formData.get('staticPostsCount')),
        imageCreativesCount: coerceFieldValue(formData.get('imageCreativesCount')),
        videoScriptsCount: coerceFieldValue(formData.get('videoScriptsCount')),
        renderVideoAfterApproval: coerceFieldValue(formData.get('renderVideoAfterApproval')),
        // One-off event campaigns: collected here as raw form strings (the
        // submit handler converts the date wall-times to tenant-local
        // end-of-day UTC instants once tenant context is resolved). Presence
        // of any field is preserved so the validator can return 422 with
        // structured field errors when required fields are missing.
        event: extractEventPayloadFromForm(formData),
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

/**
 * Read event_campaign brief fields out of FormData. Returns null when the
 * form had no event_* keys at all (weekly campaign submission); returns a
 * partial object when some fields are present so validateAndConvertEventBrief
 * can produce structured 422 errors for the missing ones.
 */
function extractEventPayloadFromForm(formData: FormData): Record<string, unknown> | null {
  const keys = ['eventName', 'eventDate', 'registrationDeadline', 'campaignEndDate', 'cta'];
  const collected: Record<string, unknown> = {};
  let anyPresent = false;
  for (const key of keys) {
    const raw = coerceFieldValue(formData.get(`event.${key}`));
    if (raw !== undefined && raw !== null && raw !== '') {
      collected[key] = raw;
      anyPresent = true;
    }
  }
  return anyPresent ? collected : null;
}

interface EventBriefValidationFailure {
  fieldErrors: Record<string, string>;
}

interface EventBriefValidationSuccess {
  event: {
    eventName: string;
    eventDate: string;
    registrationDeadline: string;
    campaignEndDate: string;
    cta: string;
  };
}

/**
 * Validate event_campaign brief fields and convert the three date strings to
 * tenant-local end-of-day UTC ISO timestamps. Form submits dates as YYYY-MM-DD
 * calendar values; the worker filter and the orchestrator's days_until_deadline
 * both want UTC instants. Conversion happens here, once, with the tenant
 * timezone in hand -- downstream code (orchestrator, schedule route, Hermes
 * payload) only ever sees UTC.
 *
 * Returns { fieldErrors } on any required-field-missing or shape-invalid case;
 * the caller maps that to a 422 with parseable field errors (matching
 * parseMarketingFieldErrors expectations in the form hook).
 *
 * Date ordering rule: registrationDeadline <= eventDate <= campaignEndDate.
 * The form enforces this client-side; the server re-checks because we cannot
 * trust the client.
 */
export function validateAndConvertEventBrief(
  raw: Record<string, unknown> | null | undefined,
  tenantId: string,
): EventBriefValidationFailure | EventBriefValidationSuccess {
  const fieldErrors: Record<string, string> = {};
  const get = (key: string): string => {
    const v = raw && typeof (raw as Record<string, unknown>)[key] === 'string'
      ? ((raw as Record<string, unknown>)[key] as string).trim()
      : '';
    return v;
  };
  const eventName = get('eventName');
  const eventDate = get('eventDate');
  const registrationDeadline = get('registrationDeadline');
  const campaignEndDate = get('campaignEndDate');
  const cta = get('cta');

  if (!eventName) fieldErrors['event.eventName'] = 'Event name is required.';
  if (!cta) fieldErrors['event.cta'] = 'CTA is required.';
  if (!eventDate) fieldErrors['event.eventDate'] = 'Event date is required.';
  if (!registrationDeadline) fieldErrors['event.registrationDeadline'] = 'Registration deadline is required.';
  if (!campaignEndDate) fieldErrors['event.campaignEndDate'] = 'Campaign end date is required.';

  // Each date is expected as YYYY-MM-DD from <input type="date">. wallTimeToUtc
  // wants YYYY-MM-DDTHH:mm, so append the end-of-day wall clock here.
  const tenantTz = loadTenantTimezoneOrFallback(tenantId);
  const toUtcEndOfDay = (value: string, field: string): string | null => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fieldErrors[field] = 'Use a YYYY-MM-DD date.';
      return null;
    }
    const wall = `${value}T23:59:59`;
    const utc = wallTimeToUtc(wall, tenantTz);
    if (!utc) {
      fieldErrors[field] = 'Invalid date.';
      return null;
    }
    return utc.toISOString();
  };

  const eventDateUtc = toUtcEndOfDay(eventDate, 'event.eventDate');
  const regDeadlineUtc = toUtcEndOfDay(registrationDeadline, 'event.registrationDeadline');
  const endDateUtc = toUtcEndOfDay(campaignEndDate, 'event.campaignEndDate');

  if (eventDateUtc && regDeadlineUtc && Date.parse(regDeadlineUtc) > Date.parse(eventDateUtc)) {
    fieldErrors['event.registrationDeadline'] = 'Registration deadline must be on or before the event date.';
  }
  if (eventDateUtc && endDateUtc && Date.parse(endDateUtc) < Date.parse(eventDateUtc)) {
    fieldErrors['event.campaignEndDate'] = 'Campaign end date must be on or after the event date.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  return {
    event: {
      eventName,
      eventDate: eventDateUtc as string,
      registrationDeadline: regDeadlineUtc as string,
      campaignEndDate: endDateUtc as string,
      cta,
    },
  };
}

function resolveRequestedJobType(rawJobType: unknown, dialect: ResponseDialect): PublicJobType {
  if (dialect === 'social-content') {
    return 'weekly_social_content';
  }
  if (typeof rawJobType === 'string' && rawJobType.trim().length > 0) {
    return rawJobType.trim() as PublicJobType;
  }
  return 'weekly_social_content';
}

function buildCreateResponse(
  dialect: ResponseDialect,
  requestedJobType: PublicJobType,
  result: Awaited<ReturnType<typeof startMarketingJob>>,
) {
  const encodedId = encodeURIComponent(result.jobId);

  if (dialect === 'social-content') {
    return {
      social_content_job_status: result.status,
      social_content_stage: result.currentStage,
      jobId: result.jobId,
      jobType: requestedJobType,
      approvalRequired: result.approvalRequired,
      approval: result.approval,
      reason: result.reason,
      message: result.message,
      jobStatusUrl: `/social-content/status?jobId=${encodedId}`,
    };
  }

  return {
    marketing_job_status: result.status,
    jobId: result.jobId,
    jobType: result.jobType,
    marketing_stage: result.currentStage,
    approvalRequired: result.approvalRequired,
    approval: result.approval,
    reason: result.reason,
    message: result.message,
    jobStatusUrl: `/marketing/job-status?jobId=${encodedId}`,
  };
}

export async function handlePostMarketingJobs(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  options?: { responseDialect?: ResponseDialect },
) {
  const dialect: ResponseDialect = options?.responseDialect ?? 'marketing';
  const requestBody = await parseCreateJobRequest(req);
  const requestedJobType = resolveRequestedJobType(requestBody.jobType, dialect);

  if (requestedJobType !== 'weekly_social_content' && requestedJobType !== 'event_campaign') {
    return NextResponse.json({ error: `unsupported_job_type:${String(requestBody.jobType ?? '')}` }, { status: 400 });
  }

  let normalizedPayload: Record<string, unknown>;
  try {
    normalizedPayload = normalizeJobPayload(requestBody.payload ?? {});
    if (requestedJobType === 'weekly_social_content') {
      normalizedPayload = normalizeWeeklySocialContentPayload(normalizedPayload);
    }
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
      tenantSlug: tenantResult.tenantContext.tenantSlug,
      payload: normalizedPayload,
    });
    const hydratedPayload = await enrichPayloadFromBusinessProfile(resolvedTenantId, normalizedPayload);

    // One-off event campaigns: validate the event brief and convert the form's
    // YYYY-MM-DD dates to tenant-local end-of-day UTC ISO strings BEFORE the
    // runtime document is persisted. Downstream code (orchestrator's
    // event_brief assembly, schedule route's campaign_end_date write, the
    // worker's WHERE clause) reads only UTC -- the timezone reasoning happens
    // here, once. A 422 with structured field errors matches the form hook's
    // parseMarketingFieldErrors expectations.
    if (requestedJobType === 'event_campaign') {
      const result = validateAndConvertEventBrief(
        hydratedPayload.event as Record<string, unknown> | null | undefined,
        resolvedTenantId,
      );
      if ('fieldErrors' in result) {
        return NextResponse.json(
          { error: 'event_brief_invalid', fieldErrors: result.fieldErrors },
          { status: 422 },
        );
      }
      hydratedPayload.event = result.event;
    }

    const result = await startMarketingJob({
      tenantId: resolvedTenantId,
      jobType: requestedJobType,
      createdBy: tenantResult.tenantContext.userId ?? null,
      payload: {
        ...hydratedPayload,
        jobType: requestedJobType,
      },
    });
    const workspace = await ensureCampaignWorkspaceRecord({
      jobId: result.jobId,
      tenantId: resolvedTenantId,
      payload: hydratedPayload,
    });
    if (requestBody.uploads.length > 0) {
      saveCampaignWorkspaceAssets(workspace, requestBody.uploads);
    }

    invalidateMarketingJobStatus(result.jobId);

    return NextResponse.json(buildCreateResponse(dialect, requestedJobType, result), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mapped = mapAriesExecutionError(error);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status });
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
      { status: 500 },
    );
  }
}
