/**
 * One-shot brand-kit refresh for a specific tenant.
 *
 * Forces a fresh scrape + Hermes enrichment even when the existing brand-kit
 * is within the normal 7-day TTL. Use this after a brand voice cleanup to bump
 * extracted_at so the campaign-list staleness badge resets.
 *
 * Usage:
 *   DATA_ROOT=/home/node/data \
 *   HERMES_GATEWAY_URL=http://localhost:8642 \
 *   HERMES_API_SERVER_KEY=<key> \
 *   ARIES_BRAND_ENRICHMENT_ENABLED=1 \
 *   tsx scripts/refresh-tenant-brand-kit.ts --tenant 15 --url https://aries.sugarandleather.com/
 */
import { parseArgs } from 'node:util';

import { extractBrandKitFromWebsite, saveTenantBrandKit } from '@/backend/marketing/brand-kit';
import { applyBrandKitEnrichment, enrichBrandKitWithGemini } from '@/backend/marketing/brand-kit-enrich';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      tenant: { type: 'string' },
      url: { type: 'string' },
    },
    strict: true,
  });

  const tenantId = values.tenant?.trim();
  const brandUrl = values.url?.trim();

  if (!tenantId || !brandUrl) {
    console.error('Usage: tsx scripts/refresh-tenant-brand-kit.ts --tenant <id> --url <https://...>');
    process.exit(1);
  }

  // Reject bare sugarandleather.com — always require the full Aries domain.
  if (/^https?:\/\/(www\.)?sugarandleather\.com/.test(brandUrl) && !/aries\.sugarandleather\.com/.test(brandUrl)) {
    console.error('ERROR: Use https://aries.sugarandleather.com/ — not bare sugarandleather.com (the leather-goods site)');
    process.exit(1);
  }

  console.log(`[refresh-brand-kit] tenant=${tenantId} url=${brandUrl}`);
  console.log('[refresh-brand-kit] Step 1: scraping website...');

  const scraped = await extractBrandKitFromWebsite({ tenantId, brandUrl });
  console.log(`[refresh-brand-kit] scraped extracted_at=${scraped.extracted_at}`);
  console.log(`[refresh-brand-kit] scraped brand_name="${scraped.brand_name}"`);

  console.log('[refresh-brand-kit] Step 2: enriching with Hermes/Gemini...');
  const enrichResult = await enrichBrandKitWithGemini({
    brandUrl,
    scrapedBrandKit: scraped,
    env: process.env,
  });

  let final = scraped;
  if (enrichResult.ok) {
    final = applyBrandKitEnrichment(scraped, enrichResult.enrichment);
    console.log('[refresh-brand-kit] Enrichment succeeded.');
    const summary = final.brand_voice_summary;
    const excerpt = summary ? summary.slice(0, 120) : '(none)';
    console.log(`[refresh-brand-kit] brand_voice_summary excerpt: "${excerpt}"`);
  } else {
    console.warn(`[refresh-brand-kit] Enrichment skipped/failed: reason=${enrichResult.reason}`);
    if ('detail' in enrichResult) {
      console.warn(`[refresh-brand-kit]   detail: ${(enrichResult as {detail?: string}).detail}`);
    }
  }

  const filePath = saveTenantBrandKit(tenantId, final);
  console.log(`[refresh-brand-kit] Saved to ${filePath}`);
  console.log(`[refresh-brand-kit] DONE. extracted_at=${final.extracted_at}`);
}

main().catch((error) => {
  console.error('[refresh-brand-kit] Fatal:', error);
  process.exit(1);
});
