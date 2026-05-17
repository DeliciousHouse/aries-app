import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { TenantBrandKit } from '../backend/marketing/brand-kit';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevCodeRoot = process.env.CODE_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-brand-kit-test-'));
  process.env.DATA_ROOT = dataRoot;
  if (!process.env.CODE_ROOT) process.env.CODE_ROOT = process.cwd();
  try {
    return await run(dataRoot);
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prevCodeRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function makeBaseKit(overrides?: Partial<TenantBrandKit>): TenantBrandKit {
  return {
    tenant_id: 'tenant1',
    source_url: 'https://example.com',
    canonical_url: 'https://example.com',
    brand_name: 'Example Brand',
    logo_urls: ['https://example.com/logo.png'],
    colors: { primary: '#333333', secondary: null, accent: null, palette: ['#333333'] },
    font_families: ['Georgia'],
    external_links: [{ platform: 'instagram', url: 'https://instagram.com/example' }],
    extracted_at: new Date(Date.now() - 60_000).toISOString(),
    brand_voice_summary: 'Brand voice here.',
    offer_summary: 'What we offer.',
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
    ...overrides,
  };
}

function freshKit(overrides?: Partial<TenantBrandKit>): TenantBrandKit {
  return makeBaseKit({ extracted_at: new Date().toISOString(), ...overrides });
}

function makeFetch(html: string): typeof fetch {
  return (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
}

const SPARSE_HTML = `<html><head><title>Acme Inc</title><meta name="description" content="Acme coaching services."></head><body><h1>Acme Inc</h1></body></html>`;

test('hasEnrichmentFields returns false when all 4 enrichment fields are null', async () => {
  const {
    saveTenantBrandKit,
    extractEnrichAndSaveTenantBrandKit,
  } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const kit = freshKit({ positioning: null, audience: null, tone_of_voice: null, style_vibe: null });
    saveTenantBrandKit('tenant1', kit);

    const noopFetch = makeFetch(SPARSE_HTML);
    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: 'tenant1',
      brandUrl: 'https://example.com',
      fetchImpl: noopFetch,
      env: { ARIES_BRAND_ENRICHMENT_ENABLED: '0' },
    });
    assert.equal(result.enriched, false, 'disabled enrichment should return enriched:false');
  });
});

test('hasEnrichmentFields returns true when ANY one of positioning/audience/tone_of_voice/style_vibe is set', async () => {
  const { saveTenantBrandKit, extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  for (const field of ['positioning', 'audience', 'tone_of_voice', 'style_vibe'] as const) {
    await withDataRoot(async () => {
      const kit = freshKit({ [field]: 'some value' } as Partial<TenantBrandKit>);
      saveTenantBrandKit('tenant1', kit);

      const result = await extractEnrichAndSaveTenantBrandKit({
        tenantId: 'tenant1',
        brandUrl: 'https://example.com',
        fetchImpl: makeFetch(SPARSE_HTML),
        env: { ARIES_BRAND_ENRICHMENT_ENABLED: '0' },
      });
      assert.equal(result.enriched, true, `kit with ${field} set should hit fast path and return enriched:true`);
    });
  }
});

test('normalizePersistedBrandKit defaults all 4 new fields to null when JSON file omits them', async () => {
  const { saveTenantBrandKit, loadTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async (dataRoot) => {
    const filePath = tenantBrandKitPath('tenant1');
    await mkdir(path.dirname(filePath), { recursive: true });

    const legacyKit = {
      tenant_id: 'tenant1',
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Example Brand',
      logo_urls: ['https://example.com/logo.png'],
      colors: { primary: '#333333', secondary: null, accent: null, palette: ['#333333'] },
      font_families: ['Georgia'],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'voice',
      offer_summary: 'offer',
    };
    await writeFile(filePath, JSON.stringify(legacyKit));

    const loaded = await loadTenantBrandKit('tenant1');
    assert.ok(loaded);
    assert.equal(loaded!.positioning, null, 'positioning should default to null');
    assert.equal(loaded!.audience, null, 'audience should default to null');
    assert.equal(loaded!.tone_of_voice, null, 'tone_of_voice should default to null');
    assert.equal(loaded!.style_vibe, null, 'style_vibe should default to null');
  });
});

test('normalizePersistedBrandKit runs cleanSentenceCandidate on 4 new fields (HTML-tainted input cleaned)', async () => {
  const { saveTenantBrandKit, loadTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const filePath = tenantBrandKitPath('tenant_clean');
    await mkdir(path.dirname(filePath), { recursive: true });

    const dirtyKit = {
      tenant_id: 'tenant_clean',
      source_url: 'https://example.com',
      canonical_url: null,
      brand_name: 'Cleaner',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: null,
      offer_summary: null,
      positioning: '<span class="bg-clip-text">Bold</span>',
      audience: '<b>Entrepreneurs</b>',
      tone_of_voice: 'warm',
      style_vibe: 'minimal',
    };
    await writeFile(filePath, JSON.stringify(dirtyKit));

    const loaded = await loadTenantBrandKit('tenant_clean');
    assert.ok(loaded);
    assert.ok(!loaded!.positioning || !loaded!.positioning.includes('<span'), 'HTML should be stripped from positioning');
    assert.equal(loaded!.audience, 'Entrepreneurs', 'audience HTML tags should be stripped');
    assert.equal(loaded!.tone_of_voice, 'warm', 'tone_of_voice should pass through cleanly');
    assert.equal(loaded!.style_vibe, 'minimal', 'style_vibe should pass through cleanly');
  });
});

test('extractEnrichAndSaveTenantBrandKit fast path: fresh kit with enrichment fields skips LLM call', async () => {
  const { saveTenantBrandKit, extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const kit = freshKit({ positioning: 'strong pos', audience: 'busy founders', tone_of_voice: 'warm', style_vibe: 'minimal' });
    saveTenantBrandKit('tenant1', kit);

    let fetchCalled = false;
    const spyFetch: typeof fetch = (async (..._args: unknown[]) => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: 'tenant1',
      brandUrl: 'https://example.com',
      fetchImpl: spyFetch,
      env: { ARIES_BRAND_ENRICHMENT_ENABLED: '1', HERMES_GATEWAY_URL: 'https://hermes.test', HERMES_API_SERVER_KEY: 'key' },
    });
    assert.equal(result.enriched, true, 'should return enriched:true for fast path');
    assert.equal(fetchCalled, false, 'should not call fetch on fast path');
  });
});

test('extractEnrichAndSaveTenantBrandKit slow path 1: fresh kit missing enrichment fields re-enriches', async () => {
  const { saveTenantBrandKit, extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const kit = freshKit({ positioning: null, audience: null, tone_of_voice: null, style_vibe: null });
    saveTenantBrandKit('tenant1', kit);

    const mockEnrichment = { brandVoiceSummary: 'voice', offerSummary: 'offer', positioning: 'pos', audience: 'aud', toneOfVoice: 'warm', styleVibe: 'minimal' };
    const runId = 'run-123';
    let callCount = 0;
    const mockFetch: typeof fetch = (async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      callCount++;
      if (url.includes('/v1/runs') && !url.includes('/run-')) {
        return new Response(JSON.stringify({ run_id: runId }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes(runId)) {
        return new Response(JSON.stringify({ status: 'completed', output: JSON.stringify({ status: 'ok', output: [mockEnrichment] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(SPARSE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: 'tenant1',
      brandUrl: 'https://example.com',
      fetchImpl: mockFetch,
      env: { ARIES_BRAND_ENRICHMENT_ENABLED: '1', HERMES_GATEWAY_URL: 'https://hermes.test', HERMES_API_SERVER_KEY: 'key' },
    });
    assert.equal(result.enriched, true, 'should return enriched:true');
    assert.equal(result.brandKit.positioning, 'pos');
    assert.equal(result.brandKit.audience, 'aud');
  });
});

test('extractEnrichAndSaveTenantBrandKit slow path 2: no existing kit scrapes and enriches', async () => {
  const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const mockEnrichment = { brandVoiceSummary: null, offerSummary: null, positioning: 'new pos', audience: null, toneOfVoice: null, styleVibe: null };
    const runId = 'run-456';
    const mockFetch: typeof fetch = (async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/v1/runs') && !url.includes(runId)) {
        return new Response(JSON.stringify({ run_id: runId }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes(runId)) {
        return new Response(JSON.stringify({ status: 'completed', output: JSON.stringify({ status: 'ok', output: [mockEnrichment] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(SPARSE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: 'tenant_new',
      brandUrl: 'https://example.com',
      fetchImpl: mockFetch,
      env: { ARIES_BRAND_ENRICHMENT_ENABLED: '1', HERMES_GATEWAY_URL: 'https://hermes.test', HERMES_API_SERVER_KEY: 'key' },
    });
    assert.equal(result.enriched, true, 'should return enriched:true');
    assert.equal(result.brandKit.positioning, 'new pos');
  });
});

test('extractEnrichAndSaveTenantBrandKit with disabled enrichment persists scraped-only kit', async () => {
  const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: 'tenant_disabled',
      brandUrl: 'https://example.com',
      fetchImpl: makeFetch(SPARSE_HTML),
      env: { ARIES_BRAND_ENRICHMENT_ENABLED: '0' },
    });
    assert.equal(result.enriched, false, 'disabled enrichment should return enriched:false');
    assert.ok(result.brandKit.brand_name, 'brand_name should still be populated from scrape');
    assert.equal(result.brandKit.positioning, null);
  });
});

test('extractEnrichAndSaveTenantBrandKit with failing enrichment (Hermes 5xx) persists scraped-only kit', async () => {
  const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const mockFetch: typeof fetch = (async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/v1/runs')) {
        return new Response('error', { status: 500 });
      }
      return new Response(SPARSE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;

    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: 'tenant_fail',
      brandUrl: 'https://example.com',
      fetchImpl: mockFetch,
      env: { ARIES_BRAND_ENRICHMENT_ENABLED: '1', HERMES_GATEWAY_URL: 'https://hermes.test', HERMES_API_SERVER_KEY: 'key' },
    });
    assert.equal(result.enriched, false, 'failed enrichment should return enriched:false');
    assert.ok(result.brandKit.brand_name, 'scrape result should be preserved');
    assert.equal(result.brandKit.positioning, null);
  });
});

test('extractEnrichAndSaveTenantBrandKit with scrape failure propagates the error', async () => {
  const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');

  await withDataRoot(async () => {
    const mockFetch: typeof fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    await assert.rejects(
      () => extractEnrichAndSaveTenantBrandKit({
        tenantId: 'tenant_scrape_fail',
        brandUrl: 'https://fail.example.com',
        fetchImpl: mockFetch,
        env: { ARIES_BRAND_ENRICHMENT_ENABLED: '0' },
      }),
      /brand_kit_/,
    );
  });
});
