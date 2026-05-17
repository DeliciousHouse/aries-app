import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS } from '@/backend/social-content/defaults';
import {
  buildSocialContentWeeklyRequest,
  ensureFreshBrandKitForWeeklyRun,
} from '@/backend/social-content/workflow-request';
import { HermesMarketingPort } from '@/backend/marketing/ports/hermes';
import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';

type WithRuntimeEnv = <T>(run: (dataRoot: string) => Promise<T>) => Promise<T>;

const withRuntimeEnv: WithRuntimeEnv = async (run) => {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-brand-kit-injection-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
};

function fullyPopulatedBrandKit() {
  return {
    path: '/tmp/brand-kit.json',
    source_url: 'https://brand.example',
    canonical_url: 'https://brand.example',
    brand_name: 'Brand Example',
    logo_urls: [
      'https://brand.example/assets/logo.svg',
      'https://brand.example/assets/wordmark.png',
    ],
    colors: {
      primary: '#9c6b3e',
      secondary: '#f3e9dd',
      accent: '#3d2410',
      palette: ['#9c6b3e', '#f3e9dd', '#3d2410', '#2b190d'],
    },
    font_families: ['Manrope', 'Cormorant Garamond'],
    external_links: [
      { platform: 'instagram', url: 'https://instagram.com/brandexample' },
    ],
    extracted_at: new Date().toISOString(),
    brand_voice_summary: 'Warm, confident, craft-led storytelling.',
    offer_summary: 'Hand-stitched leather goods, made-to-order weekly drops.',
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
  };
}

function fullyPopulatedDoc(): MarketingJobRuntimeDocument {
  return {
    tenant_id: 'tenant_full',
    job_id: 'mkt_full',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: 'https://competitor.example',
      competitor_brand: 'Competitor',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        jobType: 'weekly_social_content',
        primaryGoal: 'Book appointments',
        offer: 'Weekly drop',
        brandVoice: 'Operator-supplied voice override.',
        styleVibe: 'Heritage craft',
        audience: 'Local craft enthusiasts',
        mustAvoidAesthetics: 'fluorescent backgrounds, AI-faces',
      },
    },
    brand_kit: fullyPopulatedBrandKit(),
  } as unknown as MarketingJobRuntimeDocument;
}

test('weekly payload includes logo_urls, colors, fonts from brand kit', () => {
  const request = buildSocialContentWeeklyRequest({
    doc: fullyPopulatedDoc(),
    ariesRunId: 'arun_full',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(request.input.brand.logo_urls, [
    'https://brand.example/assets/logo.svg',
    'https://brand.example/assets/wordmark.png',
  ]);
  assert.equal(request.input.brand.colors.primary, '#9c6b3e');
  assert.equal(request.input.brand.colors.secondary, '#f3e9dd');
  assert.equal(request.input.brand.colors.accent, '#3d2410');
  assert.deepEqual(request.input.brand.colors.palette, [
    '#9c6b3e',
    '#f3e9dd',
    '#3d2410',
    '#2b190d',
  ]);
  assert.deepEqual(request.input.brand.font_families, ['Manrope', 'Cormorant Garamond']);
});

test('weekly payload: brandKit.brand_voice_summary wins over req.brandVoice; falls back to req.brandVoice when summary absent', () => {
  // brand_voice_summary set → wins over operator brandVoice (new priority per v0.1.3.25)
  const docWithOverride = fullyPopulatedDoc();
  const requestWithOverride = buildSocialContentWeeklyRequest({
    doc: docWithOverride,
    ariesRunId: 'arun_voice_override',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });
  assert.equal(requestWithOverride.input.brand.voice, 'Warm, confident, craft-led storytelling.');

  // brand_voice_summary absent → falls back to req.brandVoice
  const docWithoutSummary = fullyPopulatedDoc();
  (docWithoutSummary.brand_kit as Record<string, unknown>).brand_voice_summary = null;
  const requestFallback = buildSocialContentWeeklyRequest({
    doc: docWithoutSummary,
    ariesRunId: 'arun_voice_fallback',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });
  assert.equal(requestFallback.input.brand.voice, 'Operator-supplied voice override.');
});

test('weekly payload prefers operator offer but falls back to brand-kit summary', () => {
  const docWithoutOffer = fullyPopulatedDoc();
  const baseRequest = docWithoutOffer.inputs.request as Record<string, unknown>;
  delete baseRequest.offer;

  const request = buildSocialContentWeeklyRequest({
    doc: docWithoutOffer,
    ariesRunId: 'arun_offer_fallback',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });
  assert.equal(
    request.input.brand.offer,
    'Hand-stitched leather goods, made-to-order weekly drops.',
  );
  assert.equal(
    request.input.objective.offer,
    'Hand-stitched leather goods, made-to-order weekly drops.',
  );
});

test('weekly payload combines operator must-avoid input with FORBIDDEN_VISUAL_PATTERNS', () => {
  const request = buildSocialContentWeeklyRequest({
    doc: fullyPopulatedDoc(),
    ariesRunId: 'arun_must_avoid',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(request.input.brand.must_avoid_aesthetics.includes('fluorescent backgrounds'), true);
  assert.equal(request.input.brand.must_avoid_aesthetics.includes('AI-faces'), true);
  for (const forbidden of SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS) {
    assert.equal(
      request.input.brand.must_avoid_aesthetics.includes(forbidden),
      true,
      `expected curated forbidden pattern "${forbidden}" to flow into brand.must_avoid_aesthetics`,
    );
  }
});

test('weekly payload tolerates brand_kit with only brand_name', () => {
  const doc = {
    tenant_id: 'tenant_minimal',
    job_id: 'mkt_minimal',
    inputs: {
      brand_url: 'https://brand.example',
      request: {
        jobType: 'weekly_social_content',
      },
    },
    brand_kit: {
      brand_name: 'Brand Minimal',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_minimal',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(request.input.brand.logo_urls, []);
  assert.deepEqual(request.input.brand.font_families, []);
  assert.equal(request.input.brand.colors.primary, null);
  assert.equal(request.input.brand.colors.secondary, null);
  assert.equal(request.input.brand.colors.accent, null);
  assert.deepEqual(request.input.brand.colors.palette, []);
  assert.equal(request.input.brand.voice, '');
  assert.equal(request.input.brand.offer, '');
});

test('weekly payload sanitizes logo URLs but preserves data: SVG entries', () => {
  const doc = fullyPopulatedDoc();
  doc.brand_kit = {
    ...fullyPopulatedBrandKit(),
    logo_urls: [
      'https://brand.example/assets/logo.svg?token=secret123&w=64',
      'data:image/svg+xml;utf8,<svg></svg>',
    ],
  };

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_sanitize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(request.input.brand.logo_urls[0], 'https://brand.example/assets/logo.svg?w=64');
  assert.equal(request.input.brand.logo_urls[1], 'data:image/svg+xml;utf8,<svg></svg>');
});

test('ensureFreshBrandKitForWeeklyRun reuses persisted fresh kit and updates doc.brand_kit reference', async () => {
  await withRuntimeEnv(async () => {
    const { tenantBrandKitPath } = await import('@/backend/marketing/brand-kit');
    const filePath = tenantBrandKitPath('tenant_fresh');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        tenant_id: 'tenant_fresh',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Persisted Brand',
        logo_urls: ['https://brand.example/assets/persisted-logo.svg'],
        colors: {
          primary: '#111111',
          secondary: '#222222',
          accent: '#333333',
          palette: ['#111111', '#222222', '#333333'],
        },
        font_families: ['Persisted Serif'],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: 'Persisted voice line.',
        offer_summary: 'Persisted offer line.',
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
      }),
    );

    const doc = {
      tenant_id: 'tenant_fresh',
      job_id: 'mkt_fresh',
      inputs: {
        brand_url: 'https://brand.example',
        request: { jobType: 'weekly_social_content' },
      },
      brand_kit: null,
    } as unknown as MarketingJobRuntimeDocument;

    let fetchCalls = 0;
    const result = await ensureFreshBrandKitForWeeklyRun({
      doc,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response('unexpected', { status: 500 });
      }) as unknown as typeof fetch,
    });

    assert.equal(fetchCalls, 0);
    assert.equal(result.refreshed, true);
    assert.ok(doc.brand_kit, 'doc.brand_kit must be populated after refresh');
    assert.equal(doc.brand_kit?.brand_name, 'Persisted Brand');
    assert.deepEqual(doc.brand_kit?.logo_urls, ['https://brand.example/assets/persisted-logo.svg']);
    assert.equal(doc.brand_kit?.path, filePath);
  });
});

test('ensureFreshBrandKitForWeeklyRun re-extracts when persisted kit is stale', async () => {
  await withRuntimeEnv(async () => {
    const { tenantBrandKitPath } = await import('@/backend/marketing/brand-kit');
    const filePath = tenantBrandKitPath('tenant_stale');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        tenant_id: 'tenant_stale',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Stale Brand',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [],
        extracted_at: '2020-01-01T00:00:00.000Z',
        brand_voice_summary: null,
        offer_summary: null,
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
      }),
    );

    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      if (url === 'https://brand.example') {
        return new Response(
          `<!doctype html>
          <html>
            <head>
              <title>Refreshed Brand</title>
              <meta property="og:site_name" content="Refreshed Brand" />
              <meta name="theme-color" content="#abcdef" />
              <link rel="icon" href="/assets/refreshed-logo.svg" />
              <link rel="stylesheet" href="/assets/site.css" />
            </head>
            <body>
              <h1>Refreshed Brand</h1>
              <img src="/assets/refreshed-wordmark.png" alt="Refreshed Brand wordmark" />
            </body>
          </html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (url === 'https://brand.example/assets/site.css') {
        return new Response(
          ':root { --brand-primary: #abcdef; } body { font-family: "Inter", sans-serif; }',
          { status: 200, headers: { 'content-type': 'text/css; charset=utf-8' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const doc = {
      tenant_id: 'tenant_stale',
      job_id: 'mkt_stale',
      inputs: {
        brand_url: 'https://brand.example',
        request: { jobType: 'weekly_social_content' },
      },
      brand_kit: null,
    } as unknown as MarketingJobRuntimeDocument;

    const result = await ensureFreshBrandKitForWeeklyRun({ doc, fetchImpl });

    assert.equal(result.refreshed, true);
    assert.ok(fetchCalls.some((url) => url === 'https://brand.example'));
    assert.equal(doc.brand_kit?.brand_name, 'Refreshed Brand');
    assert.notEqual(doc.brand_kit?.extracted_at, '2020-01-01T00:00:00.000Z');

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { brand_name: string };
    assert.equal(persisted.brand_name, 'Refreshed Brand');
  });
});

test('ensureFreshBrandKitForWeeklyRun throws needs_brand_kit when brand_url is missing', async () => {
  const doc = {
    tenant_id: 'tenant_no_url',
    job_id: 'mkt_no_url',
    inputs: {
      brand_url: '',
      request: { jobType: 'weekly_social_content' },
    },
    brand_kit: null,
  } as unknown as MarketingJobRuntimeDocument;

  await assert.rejects(
    () => ensureFreshBrandKitForWeeklyRun({ doc }),
    /needs_brand_kit:brand_url_missing/,
  );
});

test('ensureFreshBrandKitForWeeklyRun throws needs_brand_kit when extraction fails', async () => {
  await withRuntimeEnv(async () => {
    const failingFetch = (async () => new Response('upstream down', { status: 500 })) as unknown as typeof fetch;
    const doc = {
      tenant_id: 'tenant_fetch_fail',
      job_id: 'mkt_fetch_fail',
      inputs: {
        brand_url: 'https://brand.example',
        request: { jobType: 'weekly_social_content' },
      },
      brand_kit: null,
    } as unknown as MarketingJobRuntimeDocument;

    await assert.rejects(
      () => ensureFreshBrandKitForWeeklyRun({ doc, fetchImpl: failingFetch }),
      /needs_brand_kit:/,
    );
  });
});

test('HermesMarketingPort surfaces needs_brand_kit when refresher rejects with that prefix', async () => {
  const port = new HermesMarketingPort(
    {
      HERMES_GATEWAY_URL: 'http://hermes.example.com',
      HERMES_API_SERVER_KEY: 'test-key',
      INTERNAL_API_SECRET: 'test-internal-secret',
      APP_BASE_URL: 'https://aries.example.com',
    },
    (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    async () => {},
    async () => {
      throw new Error('needs_brand_kit:brand_kit_fetch_failed');
    },
  );

  const doc = {
    tenant_id: 'tenant_fail',
    job_id: 'mkt_fail',
    inputs: {
      brand_url: 'https://brand.example',
      request: { jobType: 'weekly_social_content' },
    },
    brand_kit: null,
  } as unknown as MarketingJobRuntimeDocument;

  const result = await port.runPipeline({
    jobId: 'mkt_fail',
    doc,
    argsJson: '{}',
    timeoutMs: 1_000,
    maxStdoutBytes: 65_536,
  });

  assert.equal(result.kind, 'completed');
  if (result.kind !== 'completed') return;
  assert.equal(result.output?.ok, false);
  assert.equal(result.output?.status, 'failed');
  assert.equal(result.output?.error?.code, 'needs_brand_kit');
  assert.match(result.output?.error?.message ?? '', /brand_kit_fetch_failed/);
});

test('HermesMarketingPort skips brand-kit refresh for non-weekly runs', async () => {
  let refresherCalls = 0;
  const port = new HermesMarketingPort(
    {
      HERMES_GATEWAY_URL: 'http://hermes.example.com',
      HERMES_API_SERVER_KEY: 'test-key',
      INTERNAL_API_SECRET: 'test-internal-secret',
      APP_BASE_URL: 'https://aries.example.com',
    },
    (async () =>
      new Response(JSON.stringify({ run_id: 'hermes_run_xyz' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    async () => {},
    async () => {
      refresherCalls += 1;
      return { refreshed: false, enriched: false };
    },
  );

  const doc = {
    tenant_id: 'tenant_brand_only',
    job_id: 'mkt_brand_only',
    inputs: {
      brand_url: 'https://brand.example',
      request: { jobType: 'brand_campaign' },
    },
    brand_kit: null,
  } as unknown as MarketingJobRuntimeDocument;

  const result = await port.runPipeline({
    jobId: 'mkt_brand_only',
    doc,
    argsJson: '{}',
    timeoutMs: 1_000,
    maxStdoutBytes: 65_536,
  });

  assert.equal(refresherCalls, 0, 'refresher must not be invoked for brand_campaign runs');
  assert.equal(result.kind, 'submitted');
});

// Tests 28-29: ensureFreshBrandKitForWeeklyRun integration

const SPARSE_HTML = `<html><head><title>Acme</title><meta name="description" content="Acme coaching."></head><body><h1>Acme</h1></body></html>`;

test('ensureFreshBrandKitForWeeklyRun returns {refreshed: true, enriched: true} and propagates all 4 new fields', async () => {
  await withRuntimeEnv(async () => {
    const mockEnrichment = {
      brandVoiceSummary: 'Enriched voice.',
      offerSummary: 'Enriched offer.',
      positioning: 'For busy founders.',
      audience: 'Early-stage founders.',
      toneOfVoice: 'warm, bold',
      styleVibe: 'minimalist',
    };
    const runId = 'run-enrich-28';
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

    const prevEnrich = process.env.ARIES_BRAND_ENRICHMENT_ENABLED;
    const prevGateway = process.env.HERMES_GATEWAY_URL;
    const prevKey = process.env.HERMES_API_SERVER_KEY;
    process.env.ARIES_BRAND_ENRICHMENT_ENABLED = '1';
    process.env.HERMES_GATEWAY_URL = 'https://hermes.test';
    process.env.HERMES_API_SERVER_KEY = 'test-key';
    try {
      const doc = {
        tenant_id: 'tenant_enrich_28',
        job_id: 'mkt_enrich_28',
        inputs: { brand_url: 'https://acme.example.com' },
        brand_kit: null,
      } as unknown as MarketingJobRuntimeDocument;

      const result = await ensureFreshBrandKitForWeeklyRun({ doc, fetchImpl: mockFetch });
      assert.equal(result.refreshed, true, 'should be refreshed on first scrape');
      assert.equal(result.enriched, true, 'should be enriched when Hermes returns enrichment');
      assert.ok(doc.brand_kit, 'brand_kit should be set on doc');
      assert.equal(doc.brand_kit!.positioning, 'For busy founders.');
      assert.equal(doc.brand_kit!.audience, 'Early-stage founders.');
      assert.equal(doc.brand_kit!.tone_of_voice, 'warm, bold');
      assert.equal(doc.brand_kit!.style_vibe, 'minimalist');
    } finally {
      if (prevEnrich === undefined) delete process.env.ARIES_BRAND_ENRICHMENT_ENABLED;
      else process.env.ARIES_BRAND_ENRICHMENT_ENABLED = prevEnrich;
      if (prevGateway === undefined) delete process.env.HERMES_GATEWAY_URL;
      else process.env.HERMES_GATEWAY_URL = prevGateway;
      if (prevKey === undefined) delete process.env.HERMES_API_SERVER_KEY;
      else process.env.HERMES_API_SERVER_KEY = prevKey;
    }
  });
});

test('ensureFreshBrandKitForWeeklyRun returns {enriched: false} when enrichment disabled, populates only original 11 fields', async () => {
  await withRuntimeEnv(async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(SPARSE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    ) as typeof fetch;

    const prevEnrich = process.env.ARIES_BRAND_ENRICHMENT_ENABLED;
    process.env.ARIES_BRAND_ENRICHMENT_ENABLED = '0';
    try {
      const doc = {
        tenant_id: 'tenant_no_enrich_29',
        job_id: 'mkt_no_enrich_29',
        inputs: { brand_url: 'https://acme.example.com' },
        brand_kit: null,
      } as unknown as MarketingJobRuntimeDocument;

      const result = await ensureFreshBrandKitForWeeklyRun({ doc, fetchImpl: mockFetch });
      assert.equal(result.enriched, false, 'enriched should be false when disabled');
      assert.ok(doc.brand_kit, 'brand_kit should still be set from scrape');
      assert.equal(doc.brand_kit!.positioning, null, 'positioning should be null without enrichment');
      assert.equal(doc.brand_kit!.audience, null, 'audience should be null without enrichment');
      assert.equal(doc.brand_kit!.tone_of_voice, null, 'tone_of_voice should be null without enrichment');
      assert.equal(doc.brand_kit!.style_vibe, null, 'style_vibe should be null without enrichment');
    } finally {
      if (prevEnrich === undefined) delete process.env.ARIES_BRAND_ENRICHMENT_ENABLED;
      else process.env.ARIES_BRAND_ENRICHMENT_ENABLED = prevEnrich;
    }
  });
});
