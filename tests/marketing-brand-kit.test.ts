import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-brand-kit-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }

    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }

    if (previousOpenClawLobsterCwd === undefined) {
      delete process.env.OPENCLAW_LOBSTER_CWD;
    } else {
      process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

function installMarketingPipelineInvoker(): void {
  setOpenClawTestInvoker((payload) => {
    const args = (payload.args as Record<string, unknown> | undefined) ?? {};
    const action = String(args.action || '');

    if (action === 'run') {
      return {
        ok: true,
        status: 'needs_approval',
        output: [{
          run_id: 'run-research',
          executive_summary: {
            market_positioning: 'Proof-led competitive research is complete.',
            campaign_takeaway: 'Outcome-first hooks are strongest.',
          },
        }],
        requiresApproval: {
          resumeToken: 'resume_strategy',
          prompt: 'Research complete. Approve strategy to continue.',
        },
      };
    }

    throw new Error(`Unexpected OpenClaw lobster invocation: action=${action}`);
  });
}

function createFetchResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
    },
  });
}

function installBrandSiteFetchMock(): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url === 'https://sugarandleather.com') {
      return createFetchResponse(
        `<!doctype html>
        <html>
          <head>
            <title>Sugar &amp; Leather</title>
            <meta content="Sugar & Leather" property="og:site_name" />
            <meta content="/assets/social-card.jpg" property="og:image" />
            <meta name="theme-color" content="#9c6b3e" />
            <link href="https://cdn.sugarandleather.com/pages/home" rel="canonical" />
            <link href="/assets/logo-mark.svg" rel="icon" />
            <link href="https://fonts.googleapis.com" rel="preconnect" />
            <link href="/assets/site.css" rel="stylesheet" />
          </head>
          <body>
            <header>
              <a href="https://instagram.com/sugarandleather">Instagram</a>
              <a href="https://facebook.com/sugarandleather">Facebook</a>
              <a href="https://shop.sugarandleather.com/collections/frontpage">Shop</a>
              <img src="/assets/wordmark.png" alt="Sugar & Leather wordmark" />
            </header>
          </body>
        </html>`,
        'text/html; charset=utf-8'
      );
    }

    if (url === 'https://sugarandleather.com/assets/site.css') {
      return createFetchResponse(
        `:root {
          --brand-primary: #9c6b3e;
          --brand-secondary: #f3e9dd;
          --brand-accent: #3d2410;
        }
        body {
          font-family: "Manrope", sans-serif;
          color: #2b190d;
          background: #f3e9dd;
        }
        h1, h2, .display {
          font-family: "Cormorant Garamond", serif;
        }`,
        'text/css; charset=utf-8'
      );
    }

    if (url === 'https://fonts.googleapis.com') {
      return createFetchResponse('', 'text/plain; charset=utf-8');
    }

    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installRenderedColorBrandSiteFetchMock(capture?: { calls: number }): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capture && (capture.calls += 1);
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url === 'https://sugarandleather.com/') {
      return createFetchResponse(
        `<!doctype html>
        <html>
          <head>
            <title>Sugar &amp; Leather</title>
            <meta content="Sugar & Leather" property="og:site_name" />
            <link href="https://sugarandleather.com/" rel="canonical" />
            <link href="/_next/static/chunks/site.css" rel="stylesheet" />
          </head>
          <body class="font-sans">
            <header>
              <img src="/_next/image?url=%2Fbranding%2FBrandLogo.webp&w=3840&q=75" alt="Sugar & Leather logo" />
            </header>
            <section>
              <span class="text-transparent bg-clip-text bg-gradient-to-r from-[#F6339A] via-[#F6339A] via-[38%] to-[#A855F7]">Full Potential</span>
              <a class="text-[#E60076]" href="https://instagram.com/sugarandleather">Instagram</a>
            </section>
          </body>
        </html>`,
        'text/html; charset=utf-8',
      );
    }

    if (url === 'https://sugarandleather.com/_next/static/chunks/site.css') {
      return createFetchResponse(
        `:root {
          --token-red: #fb2c36;
          --token-orange: #fe6e00;
          --token-green: #05df72;
          --token-indigo: #625fff;
          --token-purple: #a855f7;
        }
        body {
          font-family: Inter, "Inter Fallback", sans-serif;
        }`,
        'text/css; charset=utf-8',
      );
    }

    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('extractBrandKitFromWebsite derives logo, palette, fonts, and social links from the canonical brand site', async () => {
  const restoreFetch = installBrandSiteFetchMock();

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({
      tenantId: 'sugarandleather',
      brandUrl: 'https://sugarandleather.com',
    });

    assert.equal(brandKit.tenant_id, 'sugarandleather');
    assert.equal(brandKit.source_url, 'https://sugarandleather.com');
    assert.equal(brandKit.brand_name, 'Sugar & Leather');
    assert.equal(brandKit.canonical_url, 'https://cdn.sugarandleather.com/pages/home');
    assert.deepEqual(brandKit.logo_urls, [
      'https://sugarandleather.com/assets/wordmark.png',
      'https://sugarandleather.com/assets/logo-mark.svg',
    ]);
    assert.equal(brandKit.colors.primary, '#9c6b3e');
    assert.equal(brandKit.colors.secondary, '#f3e9dd');
    assert.equal(brandKit.colors.accent, '#3d2410');
    assert.deepEqual(brandKit.font_families, ['Manrope', 'Cormorant Garamond']);
    assert.match(brandKit.extracted_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(brandKit.brand_voice_summary, null);
    assert.equal(brandKit.offer_summary, null);
    assert.deepEqual(brandKit.external_links, [
      { platform: 'instagram', url: 'https://instagram.com/sugarandleather' },
      { platform: 'facebook', url: 'https://facebook.com/sugarandleather' },
      { platform: 'shop.sugarandleather.com', url: 'https://shop.sugarandleather.com/collections/frontpage' },
    ]);
  } finally {
    restoreFetch();
  }
});

test('startMarketingJob persists a reusable tenant brand kit and stores a runtime reference snapshot', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const restoreFetch = installBrandSiteFetchMock();

    try {
      installMarketingPipelineInvoker();
      const { startMarketingJob } = await import('../backend/marketing/orchestrator');

      const result = await startMarketingJob({
        tenantId: 'sugarandleather',
        jobType: 'brand_campaign',
        payload: {
          brandUrl: 'https://sugarandleather.com',
          competitorUrl: 'https://betterup.com',
        },
      });

      const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${result.jobId}.json`);
      const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as any;
      const brandKitFile = path.join(dataRoot, 'generated', 'validated', 'sugarandleather', 'brand-kit.json');
      const persistedBrandKit = JSON.parse(await readFile(brandKitFile, 'utf8')) as any;

      assert.equal(runtimeDoc.brand_kit.source_url, 'https://sugarandleather.com');
      assert.equal(runtimeDoc.brand_kit.brand_name, 'Sugar & Leather');
      assert.equal(runtimeDoc.brand_kit.path, brandKitFile);
      assert.equal(runtimeDoc.brand_kit.canonical_url, 'https://cdn.sugarandleather.com/pages/home');
      assert.equal(runtimeDoc.brand_kit.colors.primary, '#9c6b3e');
      assert.deepEqual(runtimeDoc.brand_kit.font_families, ['Manrope', 'Cormorant Garamond']);
      assert.match(runtimeDoc.brand_kit.extracted_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(persistedBrandKit.tenant_id, 'sugarandleather');
      assert.equal(persistedBrandKit.brand_name, 'Sugar & Leather');
      assert.equal(persistedBrandKit.source_url, 'https://sugarandleather.com');
      assert.equal(persistedBrandKit.canonical_url, 'https://cdn.sugarandleather.com/pages/home');
      assert.equal(persistedBrandKit.colors.accent, '#3d2410');
      assert.match(persistedBrandKit.extracted_at, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      clearOpenClawTestInvoker();
      restoreFetch();
    }
  });
});

test('extractAndSaveTenantBrandKit reuses a fresh tenant brand kit instead of refetching the website', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { extractAndSaveTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');
    const filePath = tenantBrandKitPath('sugarandleather');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        tenant_id: 'sugarandleather',
        source_url: 'https://sugarandleather.com',
        canonical_url: 'https://sugarandleather.com',
        brand_name: 'Stored Sugar & Leather',
        logo_urls: ['https://sugarandleather.com/assets/stored-logo.svg'],
        colors: {
          primary: '#111111',
          secondary: '#222222',
          accent: '#333333',
          palette: ['#111111', '#222222', '#333333'],
        },
        font_families: ['Stored Serif'],
        external_links: [],
        extracted_at: new Date().toISOString(),
      }, null, 2)
    );

    let fetchCalls = 0;
    const { brandKit } = await extractAndSaveTenantBrandKit({
      tenantId: 'sugarandleather',
      brandUrl: 'https://sugarandleather.com',
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response('unexpected', { status: 500 });
      }) as unknown as typeof fetch,
    });

    assert.equal(dataRoot.length > 0, true);
    assert.equal(fetchCalls, 0);
    assert.equal(brandKit.brand_name, 'Stored Sugar & Leather');
    assert.deepEqual(brandKit.font_families, ['Stored Serif']);
  });
});

test('extractAndSaveTenantBrandKit normalizes noisy persisted brand-kit signals before reuse', async () => {
  await withRuntimeEnv(async () => {
    const { extractAndSaveTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');
    const filePath = tenantBrandKitPath('2');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        tenant_id: '2',
        source_url: 'https://sugarandleather.com/',
        canonical_url: 'https://sugarandleather.com/',
        brand_name: 'Sugar & Leather',
        logo_urls: [
          'https://sugarandleather.com/_next/image?url=%2Fbranding%2FBrandLogo.webp&w=3840&q=75',
          'https://sugarandleather.com/_next/image?url=%2Fimages%2Ftroy.webp&w=3840&q=75',
          'https://sugarandleather.com/_next/image?url=%2Fimages%2Faudrey-new.webp&w=3840&q=75',
        ],
        colors: {
          primary: '#f6339a',
          secondary: '#a855f7',
          accent: '#e60076',
          palette: ['#f6339a', '#a855f7', '#e60076', '#00000026', '#ffffff1a'],
        },
        font_families: [
          'Inter',
          'Inter Fallback',
          'Apple Color Emoji',
          'SFMono-Regular',
          'monospace)',
        ],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      }, null, 2),
    );

    let fetchCalls = 0;
    const { brandKit } = await extractAndSaveTenantBrandKit({
      tenantId: '2',
      brandUrl: 'https://sugarandleather.com/',
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response('unexpected', { status: 500 });
      }) as unknown as typeof fetch,
    });
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      logo_urls: string[];
      colors: { palette: string[] };
      font_families: string[];
    };

    assert.equal(fetchCalls, 0);
    assert.deepEqual(brandKit.logo_urls, ['https://sugarandleather.com/_next/image?url=%2Fbranding%2FBrandLogo.webp&w=3840&q=75']);
    assert.deepEqual(brandKit.font_families, ['Inter']);
    assert.deepEqual(brandKit.colors.palette, ['#f6339a', '#a855f7', '#e60076']);
    assert.deepEqual(persisted.logo_urls, brandKit.logo_urls);
    assert.deepEqual(persisted.font_families, brandKit.font_families);
    assert.deepEqual(persisted.colors.palette, brandKit.colors.palette);
  });
});

test('extractBrandKitFromWebsite prefers rendered HTML brand colors over raw stylesheet token dumps', async () => {
  const restoreFetch = installRenderedColorBrandSiteFetchMock();

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({
      tenantId: '2',
      brandUrl: 'https://sugarandleather.com/',
    });

    assert.deepEqual(brandKit.logo_urls, ['https://sugarandleather.com/_next/image?url=%2Fbranding%2FBrandLogo.webp&w=3840&q=75']);
    assert.deepEqual(brandKit.colors.palette, ['#f6339a', '#a855f7', '#e60076']);
    assert.equal(brandKit.colors.primary, '#f6339a');
    assert.equal(brandKit.colors.secondary, '#a855f7');
    assert.equal(brandKit.colors.accent, '#e60076');
    assert.deepEqual(brandKit.font_families, ['Inter']);
  } finally {
    restoreFetch();
  }
});

test('extractAndSaveTenantBrandKit refreshes fresh low-quality rainbow palettes instead of reusing them', async () => {
  await withRuntimeEnv(async () => {
    const capture = { calls: 0 };
    const restoreFetch = installRenderedColorBrandSiteFetchMock(capture);

    try {
      const { extractAndSaveTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');
      const filePath = tenantBrandKitPath('2');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          tenant_id: '2',
          source_url: 'https://sugarandleather.com/',
          canonical_url: 'https://sugarandleather.com/',
          brand_name: 'Sugar & Leather',
          logo_urls: ['https://sugarandleather.com/_next/image?url=%2Fbranding%2FBrandLogo.webp&w=3840&q=75'],
          colors: {
            primary: '#fb2c36',
            secondary: '#fe6e00',
            accent: '#05df72',
            palette: ['#fb2c36', '#fe6e00', '#05df72', '#312c85', '#a855f7'],
          },
          font_families: ['Inter'],
          external_links: [],
          extracted_at: new Date().toISOString(),
          brand_voice_summary: null,
          offer_summary: null,
        }, null, 2),
      );

      const { brandKit } = await extractAndSaveTenantBrandKit({
        tenantId: '2',
        brandUrl: 'https://sugarandleather.com/',
      });

      assert.equal(capture.calls > 0, true);
      assert.deepEqual(brandKit.colors.palette, ['#f6339a', '#a855f7', '#e60076']);
      assert.equal(brandKit.colors.primary, '#f6339a');
    } finally {
      restoreFetch();
    }
  });
});

test('extractAndSaveTenantBrandKit refreshes a stale tenant brand kit from the canonical website', async () => {
  await withRuntimeEnv(async () => {
    const restoreFetch = installBrandSiteFetchMock();

    try {
      const { extractAndSaveTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');
      const filePath = tenantBrandKitPath('sugarandleather');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          tenant_id: 'sugarandleather',
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Stale Sugar & Leather',
          logo_urls: [],
          colors: {
            primary: null,
            secondary: null,
            accent: null,
            palette: [],
          },
          font_families: [],
          external_links: [],
          extracted_at: '2020-01-01T00:00:00.000Z',
        }, null, 2)
      );

      const { brandKit } = await extractAndSaveTenantBrandKit({
        tenantId: 'sugarandleather',
        brandUrl: 'https://sugarandleather.com',
      });

      assert.equal(brandKit.brand_name, 'Sugar & Leather');
      assert.equal(brandKit.colors.primary, '#9c6b3e');
    } finally {
      restoreFetch();
    }
  });
});

test('extractAndSaveTenantBrandKit does not reuse a fresh fallback-style brand kit with no extracted signals', async () => {
  await withRuntimeEnv(async () => {
    const restoreFetch = installBrandSiteFetchMock();

    try {
      const { extractAndSaveTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');
      const filePath = tenantBrandKitPath('sugarandleather');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          tenant_id: 'sugarandleather',
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugarandleather',
          logo_urls: [],
          colors: {
            primary: null,
            secondary: null,
            accent: null,
            palette: [],
          },
          font_families: [],
          external_links: [],
          extracted_at: new Date().toISOString(),
        }, null, 2)
      );

      const { brandKit } = await extractAndSaveTenantBrandKit({
        tenantId: 'sugarandleather',
        brandUrl: 'https://sugarandleather.com',
      });

      assert.equal(brandKit.brand_name, 'Sugar & Leather');
      assert.equal(brandKit.logo_urls.length > 0, true);
      assert.equal(brandKit.font_families.length > 0, true);
    } finally {
      restoreFetch();
    }
  });
});

test('saveMarketingJobRuntime rejects brand campaign runtime documents without a brand kit snapshot or canonical source URL', async () => {
  await withRuntimeEnv(async () => {
    const { createMarketingJobRuntimeDocument, saveMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const validDoc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_brandkit_guard',
      tenantId: 'sugarandleather',
        payload: {
          brandUrl: 'https://sugarandleather.com',
          competitorUrl: 'https://betterup.com',
        },
      brandKit: {
        path: '/tmp/brand-kit.json',
        source_url: 'https://sugarandleather.com',
        canonical_url: 'https://sugarandleather.com',
        brand_name: 'Sugar & Leather',
        logo_urls: [],
        colors: {
          primary: '#9c6b3e',
          secondary: '#f3e9dd',
          accent: '#3d2410',
          palette: ['#9c6b3e', '#f3e9dd', '#3d2410'],
        },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });

    const missingBrandKit = {
      ...validDoc,
      brand_kit: null,
    } as any;
    const missingBrandUrl = {
      ...validDoc,
      inputs: {
        ...validDoc.inputs,
        brand_url: '',
      },
    };
    const mismatchedBrandSource = {
      ...validDoc,
      brand_kit: {
        ...validDoc.brand_kit,
        source_url: 'https://other-brand.example',
      },
    };
    const invalidExtractedAt = {
      ...validDoc,
      brand_kit: {
        ...validDoc.brand_kit,
        extracted_at: 'not-a-date',
      },
    };

    assert.throws(
      () => saveMarketingJobRuntime('mkt_brandkit_guard', missingBrandKit),
      /invalid_marketing_runtime_document:brand_kit_required/i
    );
    assert.throws(
      () => saveMarketingJobRuntime('mkt_brandkit_guard', missingBrandUrl as any),
      /invalid_marketing_runtime_document:brand_url_required/i
    );
    assert.throws(
      () => saveMarketingJobRuntime('mkt_brandkit_guard', mismatchedBrandSource as any),
      /invalid_marketing_runtime_document:brand_kit_source_mismatch/i
    );
    assert.throws(
      () => saveMarketingJobRuntime('mkt_brandkit_guard', invalidExtractedAt as any),
      /invalid_marketing_runtime_document:brand_kit_extracted_at_invalid/i
    );
  });
});

test('marketing runtime schema requires a brand kit snapshot and allows approval resume tokens', async () => {
  const schemaPath = path.join(PROJECT_ROOT, 'specs', 'marketing_job_state_schema.v1.json');
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as any;

  assert.equal(schema.required.includes('brand_kit'), true);
  assert.equal(schema.required.includes('inputs'), true);
  assert.equal(schema.properties.brand_kit.$ref, '#/$defs/brandKitReference');
  assert.equal(schema.$defs.brandKitReference.properties.source_url.minLength, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(schema.$defs.approvalCheckpoint.properties, 'resume_token'),
    true
  );
});

test('loadTenantBrandKit rejects malformed persisted brand kit state', async () => {
  await withRuntimeEnv(async () => {
    const { loadTenantBrandKit, tenantBrandKitPath } = await import('../backend/marketing/brand-kit');
    const filePath = tenantBrandKitPath('sugarandleather');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        tenant_id: 'sugarandleather',
        source_url: 'https://sugarandleather.com',
        canonical_url: 'https://sugarandleather.com',
        logo_urls: [],
        colors: {
          primary: '#9c6b3e',
          secondary: '#f3e9dd',
          accent: '#3d2410',
          palette: ['#9c6b3e', '#f3e9dd', '#3d2410'],
        },
        font_families: [],
        external_links: [],
        extracted_at: new Date().toISOString(),
      }, null, 2)
    );

    assert.throws(
      () => loadTenantBrandKit('sugarandleather'),
      /invalid_tenant_brand_kit:brand_name_required/i
    );
  });
});
