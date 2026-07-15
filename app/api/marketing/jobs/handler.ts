import { NextResponse } from 'next/server';

import { mapAriesExecutionError } from '@/backend/execution';
import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { recomputeAndPersistPendingApprovalCount } from '@/backend/marketing/runtime-views';
import { startSocialContentJob } from '@/backend/marketing/orchestrator';
import {
  ensureSocialContentWorkspaceRecord,
  saveSocialContentWorkspaceAssets,
  type SocialContentWorkspaceAssetUpload,
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
import { mapMarketingCreateFailure } from '@/lib/marketing-create-errors';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before starting a marketing job.',
} as const;

type PublicJobType = 'weekly_social_content' | 'one_off_post' | 'one_off_campaign';
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
  uploads: SocialContentWorkspaceAssetUpload[];
}> {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    const uploadEntries = formData.getAll('brandAssets');
    const uploads: SocialContentWorkspaceAssetUpload[] = [];

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
        storyCount: coerceFieldValue(formData.get('storyCount')),
        imageCreativeCount: coerceFieldValue(formData.get('imageCreativeCount')),
        videoScriptCount: coerceFieldValue(formData.get('videoScriptCount')),
        videoRenderCount: coerceFieldValue(formData.get('videoRenderCount')),
        // Per-job reel audio override (music | voiceover | both). Normalized +
        // dropped-if-invalid in normalizeWeeklySocialContentPayload; when absent
        // the per-tenant Settings default applies at reel ingest time.
        reelAudioMode: coerceFieldValue(formData.get('reelAudioMode')),
        postWindowDays: coerceFieldValue(formData.get('postWindowDays')),
        staticPostsCount: coerceFieldValue(formData.get('staticPostsCount')),
        storiesCount: coerceFieldValue(formData.get('storiesCount')),
        imageCreativesCount: coerceFieldValue(formData.get('imageCreativesCount')),
        videoScriptsCount: coerceFieldValue(formData.get('videoScriptsCount')),
        renderVideoAfterApproval: coerceFieldValue(formData.get('renderVideoAfterApproval')),
        // One-off event campaigns: collected here as raw form strings (the
        // submit handler converts the date wall-times to tenant-local
        // end-of-day UTC instants once tenant context is resolved). Presence
        // of any field is preserved so the validator can return 422 with
        // structured field errors when required fields are missing.
        oneOff: extractOneOffPayloadFromForm(formData),
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
 * Read one_off_campaign brief fields out of FormData. Returns null when the
 * form had no oneOff.* keys at all (weekly campaign submission); returns a
 * partial object when some fields are present so validateAndConvertOneOffBrief
 * can produce structured 422 errors for the missing required ones.
 */
function extractOneOffPayloadFromForm(formData: FormData): Record<string, unknown> | null {
  const keys = ['name', 'campaignEndDate', 'cta', 'milestoneDate', 'milestoneLabel'];
  const collected: Record<string, unknown> = {};
  let anyPresent = false;
  for (const key of keys) {
    const raw = coerceFieldValue(formData.get(`oneOff.${key}`));
    if (raw !== undefined && raw !== null && raw !== '') {
      collected[key] = raw;
      anyPresent = true;
    }
  }
  return anyPresent ? collected : null;
}

interface OneOffBriefValidationFailure {
  fieldErrors: Record<string, string>;
}

interface OneOffBriefValidationSuccess {
  oneOff: {
    name: string;
    campaignEndDate: string;
    cta: string;
    milestoneDate?: string;
    milestoneLabel?: string;
  };
}

/**
 * Validate one_off_campaign brief fields and convert the date strings to
 * tenant-local end-of-day UTC ISO timestamps. Form submits dates as YYYY-MM-DD
 * calendar values; the worker filter and the orchestrator's days_until_end
 * both want UTC instants. Conversion happens here, once, with the tenant
 * timezone in hand -- downstream code (orchestrator, schedule route, Hermes
 * payload) only ever sees UTC.
 *
 * Required fields: name, campaignEndDate, cta. Optional: milestoneDate +
 * milestoneLabel (operator-named "Registration deadline" / "Doors open" /
 * "Sale ends" / "Launch day"). Pairing rule: if either milestone field is
 * present, the other must be present too -- a date without a label is
 * meaningless, and a label without a date is unactionable.
 *
 * Returns { fieldErrors } on any required-field-missing or shape-invalid case;
 * the caller maps that to a 422 with parseable field errors (matching
 * parseMarketingFieldErrors expectations in the form hook).
 */
export function validateAndConvertOneOffBrief(
  raw: Record<string, unknown> | null | undefined,
  tenantId: string,
): OneOffBriefValidationFailure | OneOffBriefValidationSuccess {
  const fieldErrors: Record<string, string> = {};
  const get = (key: string): string => {
    const v = raw && typeof (raw as Record<string, unknown>)[key] === 'string'
      ? ((raw as Record<string, unknown>)[key] as string).trim()
      : '';
    return v;
  };
  const name = get('name');
  const campaignEndDate = get('campaignEndDate');
  const cta = get('cta');
  const milestoneDate = get('milestoneDate');
  const milestoneLabel = get('milestoneLabel');

  if (!name) fieldErrors['oneOff.name'] = 'Campaign name is required.';
  if (!cta) fieldErrors['oneOff.cta'] = 'CTA is required.';
  if (!campaignEndDate) fieldErrors['oneOff.campaignEndDate'] = 'Campaign end date is required.';

  // Milestone fields are optional but paired -- one without the other is not
  // a coherent campaign description.
  if (milestoneDate && !milestoneLabel) {
    fieldErrors['oneOff.milestoneLabel'] =
      'Add a label for this date (e.g. "Sale ends" or "Doors open").';
  }
  if (milestoneLabel && !milestoneDate) {
    fieldErrors['oneOff.milestoneDate'] = 'Pick the date this label refers to.';
  }

  // Each date is expected as YYYY-MM-DD from <input type="date">. wallTimeToUtc
  // wants YYYY-MM-DDTHH:mm, so append the end-of-day wall clock here.
  const tenantTz = loadTenantTimezoneOrFallback(tenantId);
  const nowYear = new Date().getFullYear();
  const minYear = nowYear - 1;
  const maxYear = nowYear + 10;
  const toUtcEndOfDay = (value: string, field: string): string | null => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fieldErrors[field] = 'Use a YYYY-MM-DD date.';
      return null;
    }
    const yearParsed = parseInt(value.slice(0, 4), 10);
    if (yearParsed < minYear || yearParsed > maxYear) {
      fieldErrors[field] = `Date must be a current or near-future year (between ${minYear} and ${maxYear}).`;
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

  const endDateUtc = toUtcEndOfDay(campaignEndDate, 'oneOff.campaignEndDate');
  const milestoneUtc = toUtcEndOfDay(milestoneDate, 'oneOff.milestoneDate');

  // Reject a campaign end date that is already in the past (yesterday or
  // earlier). Today is fine -- the operator may be setting up a same-day push.
  if (endDateUtc && Date.parse(endDateUtc) < Date.now()) {
    const todayWall = new Date().toLocaleDateString('en-CA', { timeZone: tenantTz });
    const todayUtc = toUtcEndOfDay(todayWall, 'oneOff.campaignEndDate');
    // If the end of the supplied date is before the start of today it's past.
    if (todayUtc && Date.parse(endDateUtc) < Date.parse(todayUtc)) {
      fieldErrors['oneOff.campaignEndDate'] = 'Campaign end date must be in the future.';
    }
  }

  // Ordering: a milestone date AFTER the campaign end is incoherent (the
  // campaign already stopped publishing). Before the end is fine -- that's
  // the common case (registration closes before the campaign window ends).
  if (endDateUtc && milestoneUtc && Date.parse(milestoneUtc) > Date.parse(endDateUtc)) {
    fieldErrors['oneOff.milestoneDate'] =
      'Milestone date must be on or before the campaign end date.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const oneOff: OneOffBriefValidationSuccess['oneOff'] = {
    name,
    campaignEndDate: endDateUtc as string,
    cta,
  };
  if (milestoneUtc && milestoneLabel) {
    oneOff.milestoneDate = milestoneUtc;
    oneOff.milestoneLabel = milestoneLabel;
  }
  return { oneOff };
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
  result: Awaited<ReturnType<typeof startSocialContentJob>>,
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

  if (requestedJobType !== 'weekly_social_content' && requestedJobType !== 'one_off_post' && requestedJobType !== 'one_off_campaign') {
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
      // fieldErrors keys the inline red highlight on the competitor input.
      return NextResponse.json(
        { error: message, message, fieldErrors: { competitorUrl: message } },
        { status: 400 },
      );
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

    // One-off campaigns: validate the brief and convert the form's YYYY-MM-DD
    // dates to tenant-local end-of-day UTC ISO strings BEFORE the runtime
    // document is persisted. Downstream code (orchestrator's one_off_brief
    // assembly, schedule route's campaign_end_date write, the worker's WHERE
    // clause) reads only UTC -- the timezone reasoning happens here, once. A
    // 422 with structured field errors matches the form hook's
    // parseMarketingFieldErrors expectations.
    if (requestedJobType === 'one_off_post' || requestedJobType === 'one_off_campaign') {
      const result = validateAndConvertOneOffBrief(
        hydratedPayload.oneOff as Record<string, unknown> | null | undefined,
        resolvedTenantId,
      );
      if ('fieldErrors' in result) {
        return NextResponse.json(
          { error: 'one_off_brief_invalid', fieldErrors: result.fieldErrors },
          { status: 422 },
        );
      }
      hydratedPayload.oneOff = result.oneOff;
    }

    const result = await startSocialContentJob({
      tenantId: resolvedTenantId,
      jobType: requestedJobType,
      createdBy: tenantResult.tenantContext.userId ?? null,
      payload: {
        ...hydratedPayload,
        jobType: requestedJobType,
      },
    });
    const workspace = await ensureSocialContentWorkspaceRecord({
      jobId: result.jobId,
      tenantId: resolvedTenantId,
      payload: hydratedPayload,
    });
    if (requestBody.uploads.length > 0) {
      saveSocialContentWorkspaceAssets(workspace, requestBody.uploads);
      // Brand assets affect brand-review-item existence -> pending_approval_count.
      await recomputeAndPersistPendingApprovalCount(result.jobId).catch((err) => {
        console.error('[jobs.create] pending-approval-count recompute failed', err);
      });
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
    // Operator-actionable failures (brand-kit fetch/extraction, missing
    // required fields) return structured fieldErrors keyed by the create
    // form's field names, so the form highlights the exact input to fix
    // (AA-131). The raw message — which can carry an inner fetch/DNS cause —
    // stays server-side in this log line and never reaches the browser.
    const createFailure = mapMarketingCreateFailure(message);
    if (createFailure) {
      console.warn('[marketing-job-create] rejected', { error: message });
      return NextResponse.json(
        {
          error: createFailure.error,
          message: createFailure.message,
          ...(createFailure.fieldErrors ? { fieldErrors: createFailure.fieldErrors } : {}),
        },
        { status: createFailure.status },
      );
    }
    if (
      message.startsWith('unsupported_job_type:') ||
      message === COMPETITOR_URL_SOCIAL_ERROR ||
      message === COMPETITOR_URL_INVALID_ERROR
    ) {
      const fieldErrors =
        message === COMPETITOR_URL_SOCIAL_ERROR || message === COMPETITOR_URL_INVALID_ERROR
          ? { competitorUrl: message }
          : undefined;
      return NextResponse.json(
        { error: message, ...(fieldErrors ? { message, fieldErrors } : {}) },
        { status: 400 },
      );
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
