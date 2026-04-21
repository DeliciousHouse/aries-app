// Regression: ISSUE-008 — Visible brand links not deduplicated.
// On /onboarding/start Step 4, "Visible brand links" listed about.nike.com
// twice and agreementservice.svs.nike.com three times (different query
// strings). external_links must dedupe by hostname+pathname, preserve
// first-seen order, and prefer the shortest URL on collision.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

resolveProjectRoot(import.meta.url);

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function runWithLinks(brandUrl: string, anchors: string[]): Promise<Array<{ platform: string; url: string }>> {
  const html = `<!doctype html><html><head><title>Demo</title></head><body>${anchors
    .map((href) => `<a href="${href}">link</a>`)
    .join('')}</body></html>`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    if (url === brandUrl) {
      return htmlResponse(html);
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const kit = await extractBrandKitFromWebsite({ tenantId: 'dedup-co', brandUrl });
    return kit.external_links;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('ISSUE-008: 5 sibling-host links with 3 unique hostname+paths collapse to 3, first-seen order preserved', async () => {
  const links = await runWithLinks('https://www.nike.com', [
    'https://about.nike.com/impact',
    'https://about.nike.com/',
    'https://agreementservice.svs.nike.com/?type=consumer-x-long',
    'https://agreementservice.svs.nike.com/?t=Y',
    'https://agreementservice.svs.nike.com/?type=consumer',
  ]);
  assert.equal(links.length, 3, `expected 3 deduped links, got ${JSON.stringify(links)}`);
  assert.equal(links[0]?.url, 'https://about.nike.com/impact');
  assert.equal(links[1]?.url, 'https://about.nike.com/');
  // Shortest of the three agreementservice variants wins.
  assert.equal(links[2]?.url, 'https://agreementservice.svs.nike.com/?t=Y');
});

test('ISSUE-008: different pathnames on same hostname are not deduped', async () => {
  const links = await runWithLinks('https://www.nike.com', [
    'https://about.nike.com/impact',
    'https://about.nike.com/careers',
  ]);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.url), [
    'https://about.nike.com/impact',
    'https://about.nike.com/careers',
  ]);
});

test('ISSUE-008: query-string-only differences are deduped, shortest URL kept', async () => {
  const links = await runWithLinks('https://www.nike.com', [
    'https://help.nike.com/?utm_source=long-tracking-string&utm_campaign=foo',
    'https://help.nike.com/?a=1',
    'https://help.nike.com/?bb=22',
  ]);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://help.nike.com/?a=1');
});

test('ISSUE-008: fragment-only differences are deduped', async () => {
  const links = await runWithLinks('https://www.nike.com', [
    'https://about.nike.com/impact#section-a',
    'https://about.nike.com/impact#section-b',
  ]);
  assert.equal(links.length, 1);
  // First-seen wins (same length).
  assert.equal(links[0]?.url, 'https://about.nike.com/impact#section-a');
});

test('ISSUE-008: empty link set yields empty external_links without crashing', async () => {
  const links = await runWithLinks('https://www.nike.com', []);
  assert.deepEqual(links, []);
});
