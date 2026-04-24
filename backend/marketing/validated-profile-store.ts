import { existsSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { MarketingBrandIdentity } from '@/lib/api/marketing';
import { sanitizeLegacyCompetitorUrl } from '@/lib/marketing-competitor';
import { resolveDataPath } from '@/lib/runtime-paths';
import {
  buildMarketingBrandIdentity,
  normalizeSourceFingerprint,
  recordMatchesCurrentSource,
  sourceFingerprintFromRecord,
} from './brand-identity';

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => stringValue(entry))
        .filter((entry): entry is string => !!entry)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return recordValue(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

function firstString(
  docs: Array<Record<string, unknown> | null>,
  selectors: Array<(value: Record<string, unknown>) => unknown>,
): string | null {
  for (const doc of docs) {
    if (!doc) continue;
    for (const selector of selectors) {
      const candidate = stringValue(selector(doc));
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function firstStringArray(
  docs: Array<Record<string, unknown> | null>,
  selectors: Array<(value: Record<string, unknown>) => unknown>,
): string[] {
  for (const doc of docs) {
    if (!doc) continue;
    for (const selector of selectors) {
      const candidate = stringArray(selector(doc));
      if (candidate.length > 0) {
        return candidate;
      }
    }
  }
  return [];
}

function firstRecord(
  docs: Array<Record<string, unknown> | null>,
  selectors: Array<(value: Record<string, unknown>) => unknown>,
): Record<string, unknown> | null {
  for (const doc of docs) {
    if (!doc) continue;
    for (const selector of selectors) {
      const candidate = recordValue(selector(doc));
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

export function tenantBrandProfilePath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'brand-profile.json');
}

export function tenantWebsiteAnalysisPath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'website-analysis.json');
}

export function tenantBusinessProfilePath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'business-profile.json');
}

export function tenantBrandKitPath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'brand-kit.json');
}

/**
 * Quarantine tenant-scoped validated docs that were written for a different
 * source URL than the campaign now starting. Prevents stale brand-profile /
 * website-analysis / business-profile content from bleeding into the new
 * campaign's approval payloads. Files with no recoverable source fingerprint
 * are quarantined too, because we cannot verify they belong to the new source.
 *
 * Renames the offending file to `<name>.stale-<ts>.json` rather than deleting,
 * so operators can still inspect prior state. brand-kit.json is handled
 * separately by extractAndSaveTenantBrandKit and is not touched here.
 */
export type QuarantinedValidatedProfile = {
  /** Path the file lived at before quarantine (does not exist post-rename). */
  originalPath: string;
  /** Path the file now lives at, so operators/logs can locate it. */
  stalePath: string;
};

export async function invalidateValidatedProfilesIfSourceChanged(
  tenantId: string,
  newSourceUrl: string | null | undefined,
): Promise<{ quarantined: QuarantinedValidatedProfile[] }> {
  const currentFingerprint = normalizeSourceFingerprint(newSourceUrl);
  if (!currentFingerprint) {
    return { quarantined: [] };
  }

  const candidates: string[] = [
    tenantBrandProfilePath(tenantId),
    tenantWebsiteAnalysisPath(tenantId),
    tenantBusinessProfilePath(tenantId),
  ];

  const quarantined: QuarantinedValidatedProfile[] = [];
  const stamp = Date.now();
  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    const record = await readJsonIfExists(filePath);
    const recordFingerprint = sourceFingerprintFromRecord(record);
    if (recordFingerprint && recordFingerprint === currentFingerprint) {
      continue;
    }
    const stalePath = filePath.replace(/\.json$/, `.stale-${stamp}.json`);
    try {
      renameSync(filePath, stalePath);
      quarantined.push({ originalPath: filePath, stalePath });
    } catch {
      // If rename fails (e.g. cross-device), leave the file; the tightened
      // matcher will still reject it at read time.
    }
  }
  return { quarantined };
}

export type ValidatedMarketingProfileDocs = {
  brandProfile: Record<string, unknown> | null;
  websiteAnalysis: Record<string, unknown> | null;
  businessProfile: Record<string, unknown> | null;
  brandKit: Record<string, unknown> | null;
  paths: {
    brandProfile: string | null;
    websiteAnalysis: string | null;
    businessProfile: string | null;
    brandKit: string | null;
  };
};

export type ValidatedMarketingProfileLoadOptions = {
  currentSourceUrl?: string | null;
};

export async function loadValidatedMarketingProfileDocs(
  tenantId: string,
  options: ValidatedMarketingProfileLoadOptions = {},
): Promise<ValidatedMarketingProfileDocs> {
  const brandProfilePath = tenantBrandProfilePath(tenantId);
  const websiteAnalysisPath = tenantWebsiteAnalysisPath(tenantId);
  const businessProfilePath = tenantBusinessProfilePath(tenantId);
  const brandKitPath = tenantBrandKitPath(tenantId);
  const rawBrandProfile = await readJsonIfExists(brandProfilePath);
  const rawWebsiteAnalysis = await readJsonIfExists(websiteAnalysisPath);
  const rawBusinessProfile = await readJsonIfExists(businessProfilePath);
  const rawBrandKit = await readJsonIfExists(brandKitPath);
  const brandProfile = recordMatchesCurrentSource(rawBrandProfile, options.currentSourceUrl) ? rawBrandProfile : null;
  const websiteAnalysis = recordMatchesCurrentSource(rawWebsiteAnalysis, options.currentSourceUrl) ? rawWebsiteAnalysis : null;
  const businessProfile = recordMatchesCurrentSource(rawBusinessProfile, options.currentSourceUrl) ? rawBusinessProfile : null;
  const brandKit = recordMatchesCurrentSource(rawBrandKit, options.currentSourceUrl) ? rawBrandKit : null;
  return {
    brandProfile,
    websiteAnalysis,
    businessProfile,
    brandKit,
    paths: {
      brandProfile: brandProfile && existsSync(brandProfilePath) ? brandProfilePath : null,
      websiteAnalysis: websiteAnalysis && existsSync(websiteAnalysisPath) ? websiteAnalysisPath : null,
      businessProfile: businessProfile && existsSync(businessProfilePath) ? businessProfilePath : null,
      brandKit: brandKit && existsSync(brandKitPath) ? brandKitPath : null,
    },
  };
}

export type ValidatedMarketingProfileSnapshot = {
  docs: ValidatedMarketingProfileDocs;
  brandName: string | null;
  brandSlug: string | null;
  websiteUrl: string | null;
  canonicalUrl: string | null;
  audience: string | null;
  positioning: string | null;
  problemStatement: string | null;
  offer: string | null;
  primaryCta: string | null;
  proofPoints: string[];
  brandVoice: string[];
  channelSpecificAngles: Record<string, unknown> | null;
  hooks: Record<string, unknown> | null;
  openingLines: Record<string, unknown> | null;
  businessName: string | null;
  businessType: string | null;
  primaryGoal: string | null;
  launchApproverName: string | null;
  channels: string[];
  competitorUrl: string | null;
  brandIdentity: MarketingBrandIdentity | null;
};

function landingHookFromDoc(doc: Record<string, unknown> | null): string | null {
  const creativeHandoffHooks = recordValue(recordValue(doc?.creative_handoff)?.hooks)?.['landing-page'];
  const analysisHooks = recordValue(recordValue(doc?.brand_analysis)?.hooks)?.['landing-page'];
  return stringArray(creativeHandoffHooks)[0] || stringArray(analysisHooks)[0] || null;
}

export async function loadValidatedMarketingProfileSnapshot(
  tenantId: string,
  options: ValidatedMarketingProfileLoadOptions = {},
): Promise<ValidatedMarketingProfileSnapshot> {
  const docs = await loadValidatedMarketingProfileDocs(tenantId, options);
  const brandProfile = docs.brandProfile;
  const websiteAnalysis = docs.websiteAnalysis;
  const websiteBrandAnalysis = recordValue(websiteAnalysis?.brand_analysis);
  const businessProfile = docs.businessProfile;
  const brandKit = docs.brandKit;
  const orderedDocs = [brandProfile, websiteAnalysis, businessProfile, brandKit];
  const websiteUrl = firstString(orderedDocs, [
    (doc) => doc.website_url,
    (doc) => recordValue(doc.creative_handoff)?.website_url,
    (doc) => recordValue(doc.brand_analysis)?.website_url,
    (doc) => doc.source_url,
  ]);
  const canonicalUrl = firstString(orderedDocs, [
    (doc) => doc.canonical_url,
    (doc) => recordValue(doc.brand_analysis)?.canonical_url,
    (doc) => doc.source_url,
  ]);
  const audience = firstString(orderedDocs, [
    (doc) => doc.audience,
    (doc) => recordValue(doc.creative_handoff)?.audience,
    (doc) => recordValue(doc.brand_analysis)?.audience,
    (doc) => recordValue(doc.brand_analysis)?.audience_summary,
  ]);
  const positioning = firstString(orderedDocs, [
    (doc) => doc.positioning,
    (doc) => recordValue(doc.creative_handoff)?.positioning,
    (doc) => recordValue(doc.brand_analysis)?.positioning,
    (doc) => recordValue(doc.brand_analysis)?.positioning_summary,
  ]);
  const offer = firstString(orderedDocs, [
    (doc) => doc.offer,
    (doc) => recordValue(doc.creative_handoff)?.offer,
    (doc) => recordValue(doc.brand_analysis)?.offer,
    (doc) => recordValue(doc.brand_analysis)?.offer_summary,
    (doc) => doc.offer_summary,
  ]);
  const primaryCta = firstString(orderedDocs, [
    (doc) => doc.primary_cta,
    (doc) => recordValue(doc.creative_handoff)?.primary_cta,
    (doc) => recordValue(doc.brand_analysis)?.primary_cta,
    (doc) => stringArray(recordValue(doc.brand_analysis)?.cta_preferences)[0],
  ]);
  const proofPoints = firstStringArray(orderedDocs, [
    (doc) => doc.proof_points,
    (doc) => recordValue(doc.creative_handoff)?.proof_points,
    (doc) => recordValue(doc.brand_analysis)?.proof_points,
  ]);
  const brandVoice = firstStringArray(orderedDocs, [
    (doc) => doc.brand_voice,
    (doc) => recordValue(doc.creative_handoff)?.brand_voice,
    (doc) => recordValue(doc.brand_analysis)?.brand_voice,
  ]);
  const brandIdentity = buildMarketingBrandIdentity({
    websiteUrl,
    canonicalUrl,
    audience,
    positioning,
    offer,
    promise: firstString(orderedDocs, [
      (doc) => doc.brand_promise,
      (doc) => recordValue(doc.creative_handoff)?.brand_promise,
      (doc) => recordValue(doc.brand_analysis)?.brand_promise,
      (doc) => landingHookFromDoc(doc),
    ]),
    primaryCta,
    proofPoints,
    brandVoice,
    styleVibe: firstString(orderedDocs, [
      (doc) => doc.style_vibe,
      (doc) => recordValue(doc.creative_handoff)?.style_vibe,
      (doc) => recordValue(doc.brand_analysis)?.style_vibe,
    ]),
    brandKit,
    hooks: firstRecord(orderedDocs, [
      (doc) => recordValue(doc.creative_handoff)?.hooks,
      (doc) => recordValue(doc.brand_analysis)?.hooks,
    ]),
  });

  return {
    docs,
    brandName: firstString(orderedDocs, [
      (doc) => doc.brand_name,
      (doc) => recordValue(doc.creative_handoff)?.brand_name,
      (doc) => recordValue(doc.brand_analysis)?.brand_name,
      (doc) => doc.business_name,
    ]),
    brandSlug: firstString(orderedDocs, [
      (doc) => doc.brand_slug,
      (doc) => recordValue(doc.creative_handoff)?.brand_slug,
      (doc) => recordValue(doc.brand_analysis)?.brand_slug,
      (doc) => doc.tenant_id,
    ]),
    websiteUrl,
    canonicalUrl,
    audience,
    positioning,
    problemStatement: firstString(orderedDocs, [
      (doc) => doc.problem_statement,
      (doc) => recordValue(doc.creative_handoff)?.problem_statement,
      (doc) => recordValue(doc.brand_analysis)?.problem_statement,
    ]),
    offer,
    primaryCta,
    proofPoints,
    brandVoice,
    channelSpecificAngles: firstRecord(orderedDocs, [
      (doc) => doc.channel_specific_angles,
      (doc) => recordValue(doc.creative_handoff)?.channel_specific_angles,
      (doc) => recordValue(doc.brand_analysis)?.channel_specific_angles,
    ]),
    hooks: firstRecord(orderedDocs, [
      (doc) => doc.hooks,
      (doc) => recordValue(doc.creative_handoff)?.hooks,
      (doc) => recordValue(doc.brand_analysis)?.hooks,
    ]),
    openingLines: firstRecord(orderedDocs, [
      (doc) => doc.opening_lines,
      (doc) => recordValue(doc.creative_handoff)?.opening_lines,
      (doc) => recordValue(doc.brand_analysis)?.opening_lines,
    ]),
    businessName: firstString(orderedDocs, [
      (doc) => doc.business_name,
      (doc) => doc.brand_name,
      (doc) => recordValue(doc.creative_handoff)?.brand_name,
      (doc) => websiteBrandAnalysis?.brand_name,
    ]),
    businessType: firstString(orderedDocs, [
      (doc) => doc.business_type,
      (doc) => recordValue(doc.brand_analysis)?.business_type,
    ]),
    primaryGoal: firstString(orderedDocs, [
      (doc) => doc.primary_goal,
      (doc) => recordValue(doc.brand_analysis)?.primary_goal,
    ]),
    launchApproverName: firstString(orderedDocs, [
      (doc) => doc.launch_approver_name,
      (doc) => recordValue(doc.brand_analysis)?.launch_approver_name,
    ]),
    channels: firstStringArray(orderedDocs, [
      (doc) => doc.channels,
      (doc) => recordValue(doc.brand_analysis)?.channels,
    ]),
    competitorUrl: sanitizeLegacyCompetitorUrl(
      firstString(orderedDocs, [
        (doc) => doc.competitor_url,
        (doc) => recordValue(doc.brand_analysis)?.competitor_url,
      ]),
    ),
    brandIdentity,
  };
}
