// AA-221 regression: the brand-kit refresh path must materialize a LOCAL logo
// file, because `logo_file_path` is the only logo source the ingest compositor
// accepts. Tenant 15's live kit had logo_urls=['https://.../aries-logo.webp']
// and logo_file_path=null, so ARIES_FEED_LOGO_COMPOSITE_ENABLED=1 composited
// exactly nothing for a whole week — silently.
//
// The bug was the CACHED FAST-PATH: a kit that was already fresh + enriched
// returned before materialization ever ran, deferring it to a backfill CLI that
// was never executed. Weekly runs always hit that path, so the logo was never
// downloaded, ever.
//
// Offline + deterministic: fetch is always injected; no test touches the network.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevCodeRoot = process.env.CODE_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-brand-kit-logo-refresh-'));
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

/** Capture console.warn without losing it for the rest of the suite. */
async function withCapturedWarn<T>(run: () => Promise<T>): Promise<{ value: T; warns: unknown[][] }> {
  const original = console.warn;
  const warns: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  try {
    const value = await run();
    return { value, warns };
  } finally {
    console.warn = original;
  }
}

const BRAND_URL = 'https://brand.example/';

// Byte-for-byte irrelevant to the assertions (nothing decodes it here) — only
// the declared content-type drives the extension choice.
const WEBP_BYTES = Buffer.from('RIFF....WEBPVP8 fake-logo-bytes', 'utf8');

/**
 * Seed a brand-kit.json that is FRESH (extracted just now, matching source_url,
 * real signals) AND enriched — precisely the shape that takes the cached
 * fast-path in extractEnrichAndSaveTenantBrandKit, i.e. tenant 15's shape.
 */
async function seedFreshEnrichedKit(
  dataRoot: string,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const kitPath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-kit.json');
  await mkdir(path.dirname(kitPath), { recursive: true });
  await writeFile(
    kitPath,
    JSON.stringify(
      {
        tenant_id: tenantId,
        source_url: BRAND_URL,
        canonical_url: BRAND_URL,
        brand_name: 'Brand Example',
        logo_urls: ['https://brand.example/aries-logo.webp'],
        logo_file_path: null,
        colors: { primary: '#111111', secondary: '#f4f4f4', accent: null, palette: ['#111111', '#f4f4f4'] },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: 'Proof-led campaigns.',
        offer_summary: 'Growth planning.',
        // Enrichment fields — required for the cached fast-path.
        positioning: 'Premium leather goods.',
        audience: 'Founders.',
        tone_of_voice: 'Warm, direct.',
        style_vibe: 'Editorial.',
        ...overrides,
      },
      null,
      2,
    ),
    'utf8',
  );
  return kitPath;
}

function webpResponse(): Response {
  return new Response(new Uint8Array(WEBP_BYTES), {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'content-length': String(WEBP_BYTES.byteLength),
    },
  });
}

test('cached fresh+enriched kit still materializes the logo and persists logo_file_path', async () => {
  await withDataRoot(async (dataRoot) => {
    const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
    const kitPath = await seedFreshEnrichedKit(dataRoot, '15');

    let fetchCalls = 0;
    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: '15',
      brandUrl: BRAND_URL,
      env: {}, // enrichment disabled — this must stay an offline unit test
      fetchImpl: (async () => {
        fetchCalls += 1;
        return webpResponse();
      }) as unknown as typeof fetch,
    });

    const expected = path.join(dataRoot, 'generated', 'validated', '15', 'logo.webp');
    assert.equal(fetchCalls, 1, 'exactly one logo download on the first refresh');
    assert.equal(result.brandKit.logo_file_path, expected, 'returned kit carries the local logo path');

    // webp needs no conversion: the compositor is sharp-backed and
    // prepareLogoOverlay re-encodes whatever it is handed.
    const written = await readFile(expected);
    assert.deepEqual(written, WEBP_BYTES, 'logo bytes are materialized verbatim');

    const persisted = JSON.parse(await readFile(kitPath, 'utf8')) as { logo_file_path?: string | null };
    assert.equal(
      persisted.logo_file_path,
      expected,
      'logo_file_path is PERSISTED — the next run reads it off disk into doc.brand_kit',
    );
  });
});

test('logo download failure fails open: refresh succeeds, logo_file_path stays null, WARN is emitted', async () => {
  await withDataRoot(async (dataRoot) => {
    const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
    const kitPath = await seedFreshEnrichedKit(dataRoot, '21');

    const { value: result, warns } = await withCapturedWarn(async () =>
      extractEnrichAndSaveTenantBrandKit({
        tenantId: '21',
        brandUrl: BRAND_URL,
        env: {},
        fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
      }),
    );

    assert.equal(result.brandKit.logo_file_path ?? null, null, 'no logo path on a failed download');
    const persisted = JSON.parse(await readFile(kitPath, 'utf8')) as { logo_file_path?: string | null };
    assert.equal(persisted.logo_file_path ?? null, null, 'nothing bogus persisted');
    assert.ok(
      warns.some((args) => String(args[0]).includes('logo materialization failed')),
      'the miss must be LOUD — a silent no-op is the original bug',
    );
    const leftover = await stat(path.join(dataRoot, 'generated', 'validated', '21', 'logo.webp'))
      .then(() => true)
      .catch(() => false);
    assert.equal(leftover, false, 'no partial logo file left behind');
  });
});

test('steady state is network-free: an existing logo file short-circuits the download', async () => {
  await withDataRoot(async (dataRoot) => {
    const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
    const logoPath = path.join(dataRoot, 'generated', 'validated', '33', 'logo.webp');
    await mkdir(path.dirname(logoPath), { recursive: true });
    await writeFile(logoPath, WEBP_BYTES);
    await seedFreshEnrichedKit(dataRoot, '33', { logo_file_path: logoPath });

    let fetchCalls = 0;
    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: '33',
      brandUrl: BRAND_URL,
      env: {},
      fetchImpl: (async () => {
        fetchCalls += 1;
        return webpResponse();
      }) as unknown as typeof fetch,
    });

    assert.equal(fetchCalls, 0, 'weekly runs must not re-download a logo that is already on disk');
    assert.equal(result.brandKit.logo_file_path, logoPath);
  });
});

test('a persisted logo_file_path whose bytes are gone is re-materialized', async () => {
  await withDataRoot(async (dataRoot) => {
    const { extractEnrichAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
    const missing = path.join(dataRoot, 'generated', 'validated', '34', 'logo.webp');
    await seedFreshEnrichedKit(dataRoot, '34', { logo_file_path: missing });

    let fetchCalls = 0;
    const result = await extractEnrichAndSaveTenantBrandKit({
      tenantId: '34',
      brandUrl: BRAND_URL,
      env: {},
      fetchImpl: (async () => {
        fetchCalls += 1;
        return webpResponse();
      }) as unknown as typeof fetch,
    });

    assert.equal(fetchCalls, 1, 'a dangling path must not pin the kit to bytes that do not exist');
    assert.equal(result.brandKit.logo_file_path, missing);
    assert.deepEqual(await readFile(missing), WEBP_BYTES);
  });
});

test('ensureLogoMaterialized never throws — a materializer blowing up is warned and swallowed', async () => {
  await withDataRoot(async () => {
    const { ensureLogoMaterialized } = await import('../backend/marketing/brand-kit');
    const kit = {
      logo_urls: ['https://brand.example/aries-logo.webp'],
      logo_file_path: null,
    } as unknown as Parameters<typeof ensureLogoMaterialized>[0]['kit'];

    const { warns } = await withCapturedWarn(async () =>
      ensureLogoMaterialized({
        tenantId: '15',
        kit,
        materialize: async () => {
          throw new Error('boom');
        },
      }),
    );

    assert.equal(kit.logo_file_path ?? null, null);
    assert.ok(
      warns.some((args) => String(args[0]).includes('logo materialization threw')),
      'the throw must be reported, not hidden',
    );
  });
});

// The load-bearing one: ensureFreshBrandKitForWeeklyRun converts ANY throw out
// of extractEnrichAndSaveTenantBrandKit into `needs_brand_kit:*`, which fails
// the entire weekly submission. A logo hiccup must never cost a tenant a week
// of content.
test('weekly brand-kit refresh survives a logo materializer that throws', async () => {
  await withDataRoot(async (dataRoot) => {
    const { ensureFreshBrandKitForWeeklyRun } = await import('../backend/social-content/workflow-request');
    await seedFreshEnrichedKit(dataRoot, '15');

    const doc = {
      tenant_id: '15',
      inputs: { brand_url: BRAND_URL, request: {} },
      brand_kit: null,
    } as unknown as Parameters<typeof ensureFreshBrandKitForWeeklyRun>[0]['doc'];

    const { value: outcome } = await withCapturedWarn(async () =>
      ensureFreshBrandKitForWeeklyRun({
        doc,
        logoMaterializer: async () => {
          throw new Error('logo host on fire');
        },
      }),
    );

    assert.equal(typeof outcome.enriched, 'boolean', 'the refresh returned normally');
    assert.ok(doc.brand_kit, 'the doc still received its brand kit reference');
    assert.equal(
      (doc.brand_kit as { logo_file_path?: string | null }).logo_file_path ?? null,
      null,
      'and simply carries no logo — exactly the pre-fix behavior, not a failure',
    );
  });
});
