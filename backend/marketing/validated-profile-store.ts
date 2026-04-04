import { existsSync, readFileSync } from 'node:fs';

import { sanitizeLegacyCompetitorUrl } from '@/lib/marketing-competitor';
import { resolveDataPath } from '@/lib/runtime-paths';

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

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return recordValue(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
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

export function loadValidatedMarketingProfileDocs(tenantId: string): ValidatedMarketingProfileDocs {
  const brandProfilePath = tenantBrandProfilePath(tenantId);
  const websiteAnalysisPath = tenantWebsiteAnalysisPath(tenantId);
  const businessProfilePath = tenantBusinessProfilePath(tenantId);
  const brandKitPath = tenantBrandKitPath(tenantId);
  return {
    brandProfile: readJsonIfExists(brandProfilePath),
    websiteAnalysis: readJsonIfExists(websiteAnalysisPath),
    businessProfile: readJsonIfExists(businessProfilePath),
    brandKit: readJsonIfExists(brandKitPath),
    paths: {
      brandProfile: existsSync(brandProfilePath) ? brandProfilePath : null,
      websiteAnalysis: existsSync(websiteAnalysisPath) ? websiteAnalysisPath : null,
      businessProfile: existsSync(businessProfilePath) ? businessProfilePath : null,
      brandKit: existsSync(brandKitPath) ? brandKitPath : null,
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
};

export function loadValidatedMarketingProfileSnapshot(tenantId: string): ValidatedMarketingProfileSnapshot {
  const docs = loadValidatedMarketingProfileDocs(tenantId);
  const brandProfile = docs.brandProfile;
  const websiteAnalysis = docs.websiteAnalysis;
  const websiteBrandAnalysis = recordValue(websiteAnalysis?.brand_analysis);
  const businessProfile = docs.businessProfile;
  const brandKit = docs.brandKit;
  const orderedDocs = [brandProfile, websiteAnalysis, businessProfile, brandKit];

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
    websiteUrl: firstString(orderedDocs, [
      (doc) => doc.website_url,
      (doc) => recordValue(doc.creative_handoff)?.website_url,
      (doc) => recordValue(doc.brand_analysis)?.website_url,
      (doc) => doc.source_url,
    ]),
    canonicalUrl: firstString(orderedDocs, [
      (doc) => doc.canonical_url,
      (doc) => recordValue(doc.brand_analysis)?.canonical_url,
      (doc) => doc.source_url,
    ]),
    audience: firstString(orderedDocs, [
      (doc) => doc.audience,
      (doc) => recordValue(doc.creative_handoff)?.audience,
      (doc) => recordValue(doc.brand_analysis)?.audience,
      (doc) => recordValue(doc.brand_analysis)?.audience_summary,
    ]),
    positioning: firstString(orderedDocs, [
      (doc) => doc.positioning,
      (doc) => recordValue(doc.creative_handoff)?.positioning,
      (doc) => recordValue(doc.brand_analysis)?.positioning,
      (doc) => recordValue(doc.brand_analysis)?.positioning_summary,
    ]),
    problemStatement: firstString(orderedDocs, [
      (doc) => doc.problem_statement,
      (doc) => recordValue(doc.creative_handoff)?.problem_statement,
      (doc) => recordValue(doc.brand_analysis)?.problem_statement,
    ]),
    offer: firstString(orderedDocs, [
      (doc) => doc.offer,
      (doc) => recordValue(doc.creative_handoff)?.offer,
      (doc) => recordValue(doc.brand_analysis)?.offer,
      (doc) => recordValue(doc.brand_analysis)?.offer_summary,
      (doc) => doc.offer_summary,
    ]),
    primaryCta: firstString(orderedDocs, [
      (doc) => doc.primary_cta,
      (doc) => recordValue(doc.creative_handoff)?.primary_cta,
      (doc) => recordValue(doc.brand_analysis)?.primary_cta,
      (doc) => stringArray(recordValue(doc.brand_analysis)?.cta_preferences)[0],
    ]),
    proofPoints: firstStringArray(orderedDocs, [
      (doc) => doc.proof_points,
      (doc) => recordValue(doc.creative_handoff)?.proof_points,
      (doc) => recordValue(doc.brand_analysis)?.proof_points,
    ]),
    brandVoice: firstStringArray(orderedDocs, [
      (doc) => doc.brand_voice,
      (doc) => recordValue(doc.creative_handoff)?.brand_voice,
      (doc) => recordValue(doc.brand_analysis)?.brand_voice,
    ]),
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
  };
}
