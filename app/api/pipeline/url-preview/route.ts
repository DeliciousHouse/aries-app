import { NextRequest, NextResponse } from 'next/server';

import { extractAndSaveTenantBrandKit, extractBrandKitFromWebsite, loadTenantBrandKit } from '@/backend/marketing/brand-kit';
import { draftTenantId, updateOnboardingDraft } from '@/backend/onboarding/draft-store';
import { normalizeMarketingWebsiteUrl } from '@/lib/marketing-public-mode';

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const BLOCKLIST = ['localhost', '127.0.0.1', 'example.com', '0.0.0.0'];

function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:') return 'Only HTTPS URLs are allowed';

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKLIST.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))) {
    return 'Domain not allowed';
  }

  if (IP_REGEX.test(hostname)) {
    return 'IP addresses are not allowed';
  }

  return null;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  const draftId = req.nextUrl.searchParams.get('draft');
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }
  if (!draftId?.trim()) {
    return NextResponse.json({ error: 'Missing draft parameter' }, { status: 400 });
  }

  const normalizedUrl = normalizeMarketingWebsiteUrl(decodeURIComponent(url));
  if (!normalizedUrl) {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const validationError = validateUrl(normalizedUrl);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const tenantId = draftTenantId(draftId);

  try {
    const storedBrandKit = loadTenantBrandKit(tenantId);
    const sameStoredBrandKit =
      storedBrandKit &&
      (storedBrandKit.source_url === normalizedUrl || storedBrandKit.canonical_url === normalizedUrl)
        ? storedBrandKit
        : null;
    const brandKit = sameStoredBrandKit
      ? (await extractAndSaveTenantBrandKit({ tenantId, brandUrl: normalizedUrl })).brandKit
      : await extractBrandKitFromWebsite({ tenantId, brandUrl: normalizedUrl });

    const response = {
      title: brandKit.brand_name,
      favicon: brandKit.logo_urls[0] || '',
      domain: new URL(normalizedUrl).hostname,
      description: brandKit.offer_summary || brandKit.brand_voice_summary || '',
      canonicalUrl: brandKit.canonical_url,
      brandKitPreview: {
        brandName: brandKit.brand_name,
        canonicalUrl: brandKit.canonical_url,
        logoUrls: brandKit.logo_urls,
        colors: brandKit.colors,
        fontFamilies: brandKit.font_families,
        externalLinks: brandKit.external_links,
        extractedAt: brandKit.extracted_at,
        brandVoiceSummary: brandKit.brand_voice_summary,
        offerSummary: brandKit.offer_summary,
      },
    };

    await updateOnboardingDraft(draftId, {
      websiteUrl: normalizedUrl,
      preview: response,
      provenance: {
        source_url: normalizedUrl,
        canonical_url: brandKit.canonical_url,
        source_fingerprint: brandKit.canonical_url || normalizedUrl,
      },
    });

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: message.startsWith('brand_kit_') ? 422 : 502 });
  }
}
