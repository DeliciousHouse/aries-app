import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { TenantBrandKit } from '../backend/marketing/brand-kit';

// A website that can't be fetched (bot-blocking 403, DNS failure) must not turn a
// stale-but-valid kit for the same url into a thrown job start: the weekly
// trigger used to 500 and retry forever for such tenants.

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const prevDataRoot = process.env.DATA_ROOT;
  const prevCodeRoot = process.env.CODE_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-brand-kit-stale-'));
  process.env.DATA_ROOT = dataRoot;
  if (!process.env.CODE_ROOT) process.env.CODE_ROOT = process.cwd();
  try {
    return await run();
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    if (prevCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prevCodeRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function staleKit(sourceUrl: string): TenantBrandKit {
  return {
    tenant_id: 'tenant1',
    source_url: sourceUrl,
    canonical_url: sourceUrl,
    brand_name: 'Example Brand',
    logo_urls: [],
    colors: { primary: '#333333', secondary: null, accent: null, palette: ['#333333'] },
    font_families: [],
    external_links: [],
    extracted_at: '2020-01-01T00:00:00.000Z',
    brand_voice_summary: 'Brand voice here.',
    offer_summary: 'What we offer.',
    positioning: null,
    audience: null,
    tone_of_voice: null,
    style_vibe: null,
  };
}

const blockedFetch = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch;

test('extractAndSaveTenantBrandKit reuses a stale kit for the same url when the site is unreachable', async () => {
  const { saveTenantBrandKit, extractAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
  await withDataRoot(async () => {
    saveTenantBrandKit('tenant1', staleKit('https://example.com'));
    const result = await extractAndSaveTenantBrandKit({
      tenantId: 'tenant1',
      brandUrl: 'https://example.com',
      fetchImpl: blockedFetch,
    });
    assert.equal(result.brandKit.brand_name, 'Example Brand');
    assert.equal(result.brandKit.extracted_at, '2020-01-01T00:00:00.000Z', 'stale kit must not be re-stamped as fresh');
  });
});

test('extractAndSaveTenantBrandKit still fails when the stored kit is for a different url', async () => {
  const { saveTenantBrandKit, extractAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
  await withDataRoot(async () => {
    saveTenantBrandKit('tenant1', staleKit('https://old-site.example'));
    await assert.rejects(
      extractAndSaveTenantBrandKit({ tenantId: 'tenant1', brandUrl: 'https://example.com', fetchImpl: blockedFetch }),
      /brand_kit/,
    );
  });
});

test('extractAndSaveTenantBrandKit still fails when there is no stored kit', async () => {
  const { extractAndSaveTenantBrandKit } = await import('../backend/marketing/brand-kit');
  await withDataRoot(async () => {
    await assert.rejects(
      extractAndSaveTenantBrandKit({ tenantId: 'tenant1', brandUrl: 'https://example.com', fetchImpl: blockedFetch }),
      /brand_kit/,
    );
  });
});
