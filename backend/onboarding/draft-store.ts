import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { normalizeMarketingWebsiteUrl } from '@/lib/marketing-public-mode';
import { resolveDataPath } from '@/lib/runtime-paths';

export type OnboardingDraftStatus =
  | 'draft'
  | 'ready_for_auth'
  | 'materializing'
  | 'materialized';

export type OnboardingDraftPreview = {
  title: string;
  favicon: string;
  domain: string;
  description: string;
  canonicalUrl: string | null;
  brandKitPreview: {
    brandName: string;
    canonicalUrl: string | null;
    logoUrls: string[];
    colors: {
      primary: string | null;
      secondary: string | null;
      accent: string | null;
      palette: string[];
    };
    fontFamilies: string[];
    externalLinks: Array<{
      platform: string;
      url: string;
    }>;
    extractedAt: string;
    brandVoiceSummary: string | null;
    offerSummary: string | null;
  } | null;
};

export type OnboardingDraftProvenance = {
  source_url: string | null;
  canonical_url: string | null;
  source_fingerprint: string | null;
};

export type OnboardingDraft = {
  draftId: string;
  status: OnboardingDraftStatus;
  websiteUrl: string;
  businessName: string;
  businessType: string;
  approverName: string;
  channels: string[];
  goal: string;
  offer: string;
  competitorUrl: string;
  preview: OnboardingDraftPreview | null;
  provenance: OnboardingDraftProvenance;
  createdAt: string;
  updatedAt: string;
  materializedTenantId: string | null;
  materializedJobId: string | null;
};

type OnboardingDraftMutation = Partial<{
  status: OnboardingDraftStatus;
  websiteUrl: string | null;
  businessName: string | null;
  businessType: string | null;
  approverName: string | null;
  channels: string[] | null;
  goal: string | null;
  offer: string | null;
  competitorUrl: string | null;
  preview: OnboardingDraftPreview | null;
  provenance: Partial<OnboardingDraftProvenance> | null;
  materializedTenantId: string | null;
  materializedJobId: string | null;
}>;

const DRAFT_ID_PATTERN = /^[a-f0-9-]{16,}$/i;

function nowIso(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringOrNull(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized || null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim()),
    ),
  );
}

function normalizeCompetitorUrl(value: string | null | undefined): string {
  return normalizeMarketingWebsiteUrl(value) || stringValue(value);
}

function normalizeDraftId(draftId: string): string {
  const normalized = draftId.trim();
  if (!DRAFT_ID_PATTERN.test(normalized)) {
    throw new Error('invalid_draft_token');
  }
  return normalized;
}

function draftDirectoryPath(): string {
  return resolveDataPath('generated', 'draft', 'onboarding-drafts');
}

function draftPath(draftId: string): string {
  return path.join(draftDirectoryPath(), `${normalizeDraftId(draftId)}.json`);
}

function emptyDraft(input?: Partial<OnboardingDraft>): OnboardingDraft {
  const timestamp = nowIso();
  const draftId = input?.draftId || crypto.randomUUID();

  return {
    draftId,
    status: input?.status || 'draft',
    websiteUrl: stringValue(input?.websiteUrl),
    businessName: stringValue(input?.businessName),
    businessType: stringValue(input?.businessType),
    approverName: stringValue(input?.approverName),
    channels: stringArray(input?.channels),
    goal: stringValue(input?.goal),
    offer: stringValue(input?.offer),
    competitorUrl: stringValue(input?.competitorUrl),
    preview: input?.preview || null,
    provenance: {
      source_url: input?.provenance?.source_url || null,
      canonical_url: input?.provenance?.canonical_url || null,
      source_fingerprint: input?.provenance?.source_fingerprint || null,
    },
    createdAt: input?.createdAt || timestamp,
    updatedAt: input?.updatedAt || timestamp,
    materializedTenantId: input?.materializedTenantId || null,
    materializedJobId: input?.materializedJobId || null,
  };
}

async function writeDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
  await mkdir(draftDirectoryPath(), { recursive: true });
  const nextDraft = {
    ...draft,
    updatedAt: nowIso(),
  };
  await writeFile(draftPath(draft.draftId), JSON.stringify(nextDraft, null, 2));
  return nextDraft;
}

function sanitizePreview(value: unknown): OnboardingDraftPreview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const preview = value as Record<string, unknown>;
  const brandKitPreview =
    preview.brandKitPreview && typeof preview.brandKitPreview === 'object' && !Array.isArray(preview.brandKitPreview)
      ? (preview.brandKitPreview as Record<string, unknown>)
      : null;
  const colors =
    brandKitPreview?.colors && typeof brandKitPreview.colors === 'object' && !Array.isArray(brandKitPreview.colors)
      ? (brandKitPreview.colors as Record<string, unknown>)
      : null;

  return {
    title: stringValue(preview.title),
    favicon: stringValue(preview.favicon),
    domain: stringValue(preview.domain),
    description: stringValue(preview.description),
    canonicalUrl: stringOrNull(preview.canonicalUrl),
    brandKitPreview: brandKitPreview
      ? {
          brandName: stringValue(brandKitPreview.brandName),
          canonicalUrl: stringOrNull(brandKitPreview.canonicalUrl),
          logoUrls: stringArray(brandKitPreview.logoUrls),
          colors: {
            primary: stringOrNull(colors?.primary),
            secondary: stringOrNull(colors?.secondary),
            accent: stringOrNull(colors?.accent),
            palette: stringArray(colors?.palette),
          },
          fontFamilies: stringArray(brandKitPreview.fontFamilies),
          externalLinks: Array.isArray(brandKitPreview.externalLinks)
            ? brandKitPreview.externalLinks
                .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
                .map((entry) => ({
                  platform: stringValue(entry.platform),
                  url: stringValue(entry.url),
                }))
                .filter((entry) => entry.platform || entry.url)
            : [],
          extractedAt: stringValue(brandKitPreview.extractedAt),
          brandVoiceSummary: stringOrNull(brandKitPreview.brandVoiceSummary),
          offerSummary: stringOrNull(brandKitPreview.offerSummary),
        }
      : null,
  };
}

function sanitizeProvenance(
  value: Partial<OnboardingDraftProvenance> | null | undefined,
): OnboardingDraftProvenance {
  return {
    source_url: normalizeMarketingWebsiteUrl(value?.source_url) || null,
    canonical_url: normalizeMarketingWebsiteUrl(value?.canonical_url) || null,
    source_fingerprint: normalizeMarketingWebsiteUrl(value?.source_fingerprint) || null,
  };
}

function draftSourceFingerprint(input: {
  websiteUrl?: string | null;
  provenance?: Partial<OnboardingDraftProvenance> | null;
}): string | null {
  return (
    normalizeMarketingWebsiteUrl(input.provenance?.source_fingerprint) ||
    normalizeMarketingWebsiteUrl(input.provenance?.canonical_url) ||
    normalizeMarketingWebsiteUrl(input.websiteUrl) ||
    null
  );
}

function applyDraftMutation(draft: OnboardingDraft, mutation: OnboardingDraftMutation): OnboardingDraft {
  const nextWebsiteUrl = mutation.websiteUrl === undefined
    ? draft.websiteUrl
    : normalizeMarketingWebsiteUrl(mutation.websiteUrl) || stringValue(mutation.websiteUrl);
  const nextPreview = mutation.preview === undefined ? draft.preview : sanitizePreview(mutation.preview);
  const nextProvenance = mutation.provenance === undefined
    ? draft.provenance
    : sanitizeProvenance({ ...draft.provenance, ...mutation.provenance });
  const nextFingerprintCandidate = mutation.provenance === undefined
    ? {
        source_url: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
        canonical_url: null,
        source_fingerprint: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
      }
    : nextProvenance;
  const sourceChanged =
    draftSourceFingerprint({ websiteUrl: draft.websiteUrl, provenance: draft.provenance }) !==
    draftSourceFingerprint({ websiteUrl: nextWebsiteUrl, provenance: nextFingerprintCandidate });

  return {
    ...draft,
    status: mutation.status || draft.status,
    websiteUrl: nextWebsiteUrl,
    businessName: mutation.businessName === undefined ? draft.businessName : stringValue(mutation.businessName),
    businessType: mutation.businessType === undefined ? draft.businessType : stringValue(mutation.businessType),
    approverName: mutation.approverName === undefined ? draft.approverName : stringValue(mutation.approverName),
    channels: mutation.channels === undefined ? draft.channels : stringArray(mutation.channels),
    goal: mutation.goal === undefined ? draft.goal : stringValue(mutation.goal),
    offer: mutation.offer === undefined ? draft.offer : stringValue(mutation.offer),
    competitorUrl:
      mutation.competitorUrl === undefined
        ? draft.competitorUrl
        : normalizeCompetitorUrl(mutation.competitorUrl),
    preview: sourceChanged && mutation.preview === undefined ? null : nextPreview,
    provenance: sourceChanged && mutation.provenance === undefined
      ? {
          source_url: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
          canonical_url: null,
          source_fingerprint: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
        }
      : nextProvenance,
    materializedTenantId:
      mutation.materializedTenantId === undefined ? draft.materializedTenantId : stringOrNull(mutation.materializedTenantId),
    materializedJobId:
      mutation.materializedJobId === undefined ? draft.materializedJobId : stringOrNull(mutation.materializedJobId),
  };
}

export function draftTenantId(draftId: string): string {
  return `draft_${normalizeDraftId(draftId).replace(/-/g, '')}`;
}

export async function createOnboardingDraft(initial?: Partial<OnboardingDraft>): Promise<OnboardingDraft> {
  return writeDraft(emptyDraft(initial));
}

export async function getOnboardingDraft(draftId: string): Promise<OnboardingDraft | null> {
  try {
    const parsed = JSON.parse(await readFile(draftPath(draftId), 'utf8')) as Partial<OnboardingDraft>;
    return emptyDraft(parsed);
  } catch {
    return null;
  }
}

export async function requireOnboardingDraft(draftId: string): Promise<OnboardingDraft> {
  const draft = await getOnboardingDraft(draftId);
  if (!draft) {
    throw new Error('draft_not_found');
  }
  return draft;
}

export async function updateOnboardingDraft(
  draftId: string,
  mutation: OnboardingDraftMutation,
): Promise<OnboardingDraft> {
  const current = await requireOnboardingDraft(draftId);
  return writeDraft(applyDraftMutation(current, mutation));
}
