import { NextResponse } from 'next/server';

import {
  createOnboardingDraft,
  getOnboardingDraft,
  updateOnboardingDraft,
  type OnboardingDraftPreview,
  type OnboardingDraftStatus,
} from '@/backend/onboarding/draft-store';

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function validStatus(value: unknown): OnboardingDraftStatus | undefined {
  if (value === 'draft' || value === 'ready_for_auth' || value === 'materializing' || value === 'materialized') {
    return value;
  }
  return undefined;
}

function draftIdFrom(req: Request): string | null {
  const draftId = new URL(req.url).searchParams.get('draft');
  return draftId?.trim() || null;
}

export async function POST() {
  const draft = await createOnboardingDraft();
  return NextResponse.json({ draft }, { status: 201 });
}

export async function GET(req: Request) {
  const draftId = draftIdFrom(req);
  if (!draftId) {
    return NextResponse.json({ error: 'draft_token_required' }, { status: 400 });
  }

  const draft = await getOnboardingDraft(draftId);
  if (!draft) {
    return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
  }

  return NextResponse.json({ draft }, { status: 200 });
}

export async function PATCH(req: Request) {
  const draftId = draftIdFrom(req);
  if (!draftId) {
    return NextResponse.json({ error: 'draft_token_required' }, { status: 400 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  try {
    const draft = await updateOnboardingDraft(draftId, {
      status: validStatus(payload.status),
      websiteUrl: payload.websiteUrl === undefined ? undefined : stringValue(payload.websiteUrl),
      businessName: payload.businessName === undefined ? undefined : stringValue(payload.businessName),
      businessType: payload.businessType === undefined ? undefined : stringValue(payload.businessType),
      approverName: payload.approverName === undefined ? undefined : stringValue(payload.approverName),
      channels: payload.channels === undefined ? undefined : stringArray(payload.channels),
      goal: payload.goal === undefined ? undefined : stringValue(payload.goal),
      offer: payload.offer === undefined ? undefined : stringValue(payload.offer),
      competitorUrl: payload.competitorUrl === undefined ? undefined : stringValue(payload.competitorUrl),
      preview: payload.preview === undefined ? undefined : (payload.preview as OnboardingDraftPreview | null),
      provenance:
        payload.provenance && typeof payload.provenance === 'object' && !Array.isArray(payload.provenance)
          ? (payload.provenance as Record<string, string | null>)
          : payload.provenance === null
            ? null
            : undefined,
      materializedTenantId:
        payload.materializedTenantId === undefined ? undefined : stringValue(payload.materializedTenantId),
      materializedJobId:
        payload.materializedJobId === undefined ? undefined : stringValue(payload.materializedJobId),
    });

    return NextResponse.json({ draft }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'draft_not_found' ? 404 : message === 'invalid_draft_token' ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
