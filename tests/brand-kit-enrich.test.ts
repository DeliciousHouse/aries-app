import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichBrandKitWithGemini } from '@/backend/marketing/brand-kit-enrich';
import type { TenantBrandKit } from '@/backend/marketing/brand-kit';

const SCRAPED: TenantBrandKit = {
  tenant_id: 'draft_test',
  source_url: 'https://example.com/',
  canonical_url: 'https://example.com/',
  brand_name: 'Example Co',
  logo_urls: ['https://example.com/logo.png'],
  colors: { primary: '#ff0000', secondary: '#00ff00', accent: '#0000ff', palette: ['#ff0000', '#00ff00', '#0000ff'] },
  font_families: ['Inter'],
  external_links: [{ platform: 'instagram', url: 'https://instagram.com/example' }],
  extracted_at: '2026-05-07T00:00:00.000Z',
  brand_voice_summary: 'Truncated meta description fragment.',
  offer_summary: 'Truncated offer fragment.',
  positioning: null,
  audience: null,
  tone_of_voice: null,
  style_vibe: null,
};

const HTML_RESPONSE = new Response(
  '<html><head><title>Example</title></head><body><h1>Welcome</h1><p>We help builders ship.</p></body></html>',
  { status: 200, headers: { 'content-type': 'text/html' } },
);

test('enrichBrandKitWithGemini strips malformed script/style closing tags before prompting', async () => {
  const prompts: string[] = [];
  const html = new Response(
    '<html><body><script>secretScript()</script\t\n junk><style>.secret{color:red}</style bad><p>Visible copy.</p></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  );
  const completedOutput = JSON.stringify({
    status: 'ok',
    output: [
      {
        brandVoiceSummary: 'Visible.',
        offerSummary: null,
        positioning: null,
        audience: null,
        toneOfVoice: null,
        styleVibe: null,
      },
    ],
  });
  const fetchImpl = makeFetchSequence([
    async () => html.clone(),
    async (_input?: string | URL, init?: RequestInit) => {
      prompts.push(String((JSON.parse(String(init?.body)) as { input: string }).input));
      return jsonResponse({ run_id: 'run-malformed-html' });
    },
    async () => jsonResponse({ status: 'completed', output: completedOutput }),
  ]);

  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: '1',
      HERMES_GATEWAY_URL: 'http://hermes.test',
      HERMES_API_SERVER_KEY: 'k',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Visible copy/);
  assert.doesNotMatch(prompts[0], /secretScript|secret\{color:red\}/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetchSequence(responses: Array<(input: string | URL, init?: RequestInit) => Promise<Response>>): typeof globalThis.fetch {
  let i = 0;
  return (async (input: string | URL, init?: RequestInit) => {
    const next = responses[i++];
    if (!next) throw new Error(`fetch called more than expected (${i})`);
    return next(input, init);
  }) as typeof globalThis.fetch;
}

test('enrichBrandKitWithGemini returns disabled when feature flag is off', async () => {
  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: '0',
      HERMES_GATEWAY_URL: 'http://hermes.test',
      HERMES_API_SERVER_KEY: 'k',
    },
    fetchImpl: () => {
      throw new Error('fetch should not be called when disabled');
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'disabled' });
});

test('enrichBrandKitWithGemini returns not_configured when Hermes env missing', async () => {
  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: { ARIES_BRAND_ENRICHMENT_ENABLED: '1' },
    fetchImpl: () => {
      throw new Error('fetch should not be called when not configured');
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'not_configured' });
});

test('enrichBrandKitWithGemini submit then poll returns parsed enrichment', async () => {
  const completedOutput = JSON.stringify({
    status: 'ok',
    output: [
      {
        brandVoiceSummary: 'Direct, builder-focused, slightly irreverent.',
        offerSummary: 'A platform that helps builders ship faster.',
        positioning: 'For solo builders who would rather ship than configure tools.',
        audience: 'Indie hackers and small teams shipping their first product.',
        toneOfVoice: 'direct, warm, irreverent, technical, confident',
        styleVibe: 'minimal, dark, monospace, sharp, contemporary',
      },
    ],
  });

  const fetchImpl = makeFetchSequence([
    async () => HTML_RESPONSE.clone(), // source page fetch
    async () => jsonResponse({ run_id: 'run-123' }), // submit
    async () => jsonResponse({ status: 'completed', output: completedOutput }), // first poll
  ]);

  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: '1',
      HERMES_GATEWAY_URL: 'http://hermes.test/',
      HERMES_API_SERVER_KEY: 'secret',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.enrichment.brandVoiceSummary, 'Direct, builder-focused, slightly irreverent.');
  assert.equal(result.enrichment.positioning?.startsWith('For solo builders'), true);
  assert.equal(result.enrichment.toneOfVoice, 'direct, warm, irreverent, technical, confident');
});

test('enrichBrandKitWithGemini polls until terminal status', async () => {
  const completedOutput = JSON.stringify({
    output: [{ brandVoiceSummary: 'Done.', offerSummary: null, positioning: null, audience: null, toneOfVoice: null, styleVibe: null }],
  });
  const fetchImpl = makeFetchSequence([
    async () => HTML_RESPONSE.clone(),
    async () => jsonResponse({ run_id: 'run-456' }),
    async () => jsonResponse({ status: 'running' }),
    async () => jsonResponse({ status: 'running' }),
    async () => jsonResponse({ status: 'completed', output: completedOutput }),
  ]);

  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: 'true',
      HERMES_GATEWAY_URL: 'http://hermes.test',
      HERMES_API_SERVER_KEY: 'k',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.enrichment.brandVoiceSummary, 'Done.');
  }
});

test('enrichBrandKitWithGemini reports run_failed on terminal failure', async () => {
  const fetchImpl = makeFetchSequence([
    async () => HTML_RESPONSE.clone(),
    async () => jsonResponse({ run_id: 'run-789' }),
    async () => jsonResponse({ status: 'failed', error: 'model exploded' }),
  ]);

  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: '1',
      HERMES_GATEWAY_URL: 'http://hermes.test',
      HERMES_API_SERVER_KEY: 'k',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'run_failed');
    assert.equal(result.detail, 'failed');
  }
});

test('enrichBrandKitWithGemini reports unreachable when Hermes is down', async () => {
  const fetchImpl: typeof globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/v1/runs')) {
      throw new TypeError('fetch failed');
    }
    return HTML_RESPONSE.clone();
  }) as typeof globalThis.fetch;

  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: '1',
      HERMES_GATEWAY_URL: 'http://hermes.test',
      HERMES_API_SERVER_KEY: 'k',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unreachable');
});

test('enrichBrandKitWithGemini reports output_invalid when JSON is unparseable', async () => {
  const fetchImpl = makeFetchSequence([
    async () => HTML_RESPONSE.clone(),
    async () => jsonResponse({ run_id: 'run-abc' }),
    async () => jsonResponse({ status: 'completed', output: 'this is not json' }),
  ]);

  const result = await enrichBrandKitWithGemini({
    brandUrl: 'https://example.com/',
    scrapedBrandKit: SCRAPED,
    env: {
      ARIES_BRAND_ENRICHMENT_ENABLED: '1',
      HERMES_GATEWAY_URL: 'http://hermes.test',
      HERMES_API_SERVER_KEY: 'k',
      HERMES_POLL_INTERVAL_MS: '0',
    },
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'output_invalid');
});
