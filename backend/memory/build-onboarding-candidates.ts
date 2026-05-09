import type { BusinessProfileView } from '@/backend/tenant/business-profile';
import type { CandidateFinding } from './types';

function nowIso(): string {
  return new Date().toISOString();
}

function asHttpsSourceUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^http:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      u.protocol = 'https:';
      return u.toString();
    } catch {
      return null;
    }
  }
  try {
    return new URL(`https://${trimmed}`).toString();
  } catch {
    return null;
  }
}

/**
 * Derives discrete first-party candidate facts from an onboarded business profile
 * for Honcho seeding (plan: onboarding memory seed — curated only).
 */
export function buildOnboardingCandidatesFromProfile(profile: BusinessProfileView): CandidateFinding[] {
  const fetchedAt = nowIso();
  const out: CandidateFinding[] = [];

  const website = asHttpsSourceUrl(profile.websiteUrl);
  if (website) {
    out.push({
      kind: 'fact',
      claim: `Official website URL is ${website}.`,
      sources: [{ url: website, fetched_at: fetchedAt, trust: 'first_party' }],
      confidence: 0.86,
      peerHint: 'brand',
    });
  }

  const name = profile.businessName?.trim();
  if (name && name.length <= 500) {
    const sourceUrl = website ?? asHttpsSourceUrl(profile.brandKit?.canonical_url ?? profile.brandKit?.source_url);
    if (sourceUrl) {
      out.push({
        kind: 'fact',
        claim: `Registered business name is ${name}.`,
        sources: [{ url: sourceUrl, fetched_at: fetchedAt, trust: 'first_party' }],
        confidence: 0.86,
        peerHint: 'brand',
      });
    }
  }

  const links = profile.brandKit?.external_links ?? [];
  for (const link of links) {
    const url = asHttpsSourceUrl(link.url);
    if (!url) continue;
    out.push({
      kind: 'fact',
      claim: `Public ${link.platform} profile: ${url}.`,
      sources: [{ url, fetched_at: fetchedAt, trust: 'third_party' }],
      confidence: 0.9,
      peerHint: 'brand',
    });
  }

  return out;
}
