import { NextResponse } from 'next/server';

import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import {
  getOperatorCreativePreferences,
  upsertOperatorCreativePreferences,
} from '@/backend/marketing/operator-creative-preferences-store';
import { scheduleCreativeVoicePreferenceHonchoWrite } from '@/backend/memory/write-events';
import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before changing creative preferences.',
} as const;

export const VOICE_STYLE_LABEL_MAX_LENGTH = 200;

const JOB_NOT_FOUND = {
  status: 'error' as const,
  error: 'Social content job not found.',
  reason: 'social_content_job_not_found',
};

function ymdUtcToday(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

export async function handleGetCreativeVoicePreference(
  jobId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;

  const doc = await loadMarketingJobRuntime(jobId);
  if (!doc || doc.tenant_id !== tenantContext.tenantId) {
    return NextResponse.json(JOB_NOT_FOUND, { status: 404 });
  }

  const row = await getOperatorCreativePreferences(tenantContext.tenantId, tenantContext.userId, pool);
  return NextResponse.json({
    status: 'ok',
    always_match_creative_voice: row?.always_match_creative_voice ?? false,
    voice_style_label: row?.voice_style_label ?? null,
    updated_at: row?.updated_at ?? null,
  });
}

export async function handlePutCreativeVoicePreference(
  jobId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;

  if (tenantContext.role === 'tenant_viewer') {
    return NextResponse.json(
      { status: 'error', error: 'Insufficient permissions.', reason: 'forbidden' },
      { status: 403 },
    );
  }

  const doc = await loadMarketingJobRuntime(jobId);
  if (!doc || doc.tenant_id !== tenantContext.tenantId) {
    return NextResponse.json(JOB_NOT_FOUND, { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const rawFlag = body.always_match_creative_voice ?? body.alwaysMatchCreativeVoice;
  if (typeof rawFlag !== 'boolean') {
    return NextResponse.json(
      {
        status: 'error',
        error: 'always_match_creative_voice must be a boolean.',
        reason: 'invalid_body',
      },
      { status: 400 },
    );
  }

  const rawLabel = body.voice_style_label ?? body.voiceStyleLabel;
  let voiceLabel: string | null = null;
  if (typeof rawLabel === 'string') {
    const trimmed = rawLabel.trim();
    if (trimmed.length > VOICE_STYLE_LABEL_MAX_LENGTH) {
      return NextResponse.json(
        {
          status: 'error',
          error: `voice_style_label must be ${VOICE_STYLE_LABEL_MAX_LENGTH} characters or fewer.`,
          reason: 'voice_style_label_too_long',
        },
        { status: 400 },
      );
    }
    voiceLabel = trimmed.length > 0 ? trimmed : null;
  }

  const saved = await upsertOperatorCreativePreferences(
    {
      tenantId: tenantContext.tenantId,
      userId: tenantContext.userId,
      always_match_creative_voice: rawFlag,
      voice_style_label: voiceLabel,
    },
    pool,
  );

  scheduleCreativeVoicePreferenceHonchoWrite({
    tenantCtx: {
      tenantId: tenantContext.tenantId,
      tenantSlug: tenantContext.tenantSlug,
      userId: tenantContext.userId,
      role: tenantContext.role,
    },
    memoryActorUserId: tenantContext.userId,
    jobId,
    alwaysMatchCreativeVoice: saved.always_match_creative_voice,
    voiceStyleLabel: saved.voice_style_label,
    eventDateYmd: ymdUtcToday(),
    explicitUserIntent: true,
  });

  return NextResponse.json({
    status: 'ok',
    always_match_creative_voice: saved.always_match_creative_voice,
    voice_style_label: saved.voice_style_label,
    updated_at: saved.updated_at,
  });
}
