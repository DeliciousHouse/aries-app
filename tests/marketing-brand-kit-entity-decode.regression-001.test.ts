// Regression: ISSUE-003 / ISSUE-007 — htmlToText left raw `&#x27;` artifacts
// in scraped brand voice/revision-notes (e.g. "world& x27;s athletes" from
// Nike's hex-encoded apostrophes).
// Found by /qa on 2026-04-20 against https://aries.sugarandleather.com
// Report: .gstack/qa-reports/qa-report-aries-sugarandleather-com-2026-04-20.md
//
// Root cause: decodeHtmlEntities only handled 5 named entities and missed
// hex (&#x27;), decimal (&#XX;), and additional named entities.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

resolveProjectRoot(import.meta.url);

function createFetchResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

test('extractBrandKitFromWebsite decodes hex HTML entities (Nike-style &#x27;)', async () => {
  const originalFetch = globalThis.fetch;
  const brandUrl = 'https://hex-entity.example';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    if (url === brandUrl) {
      return createFetchResponse(
        `<!doctype html>
        <html>
          <head>
            <title>Hex Co</title>
            <meta name="description" content="Inspiring the world&#x27;s athletes &mdash; Hex Co delivers innovative experiences.">
          </head>
          <body>
            <h1>Hex Co Heading</h1>
            <p>It&#x27;s time to ship. Bull&#8226; markdown. Already&apos;s decoded.</p>
          </body>
        </html>`,
        'text/html; charset=utf-8',
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({
      tenantId: 'hex-entity-co',
      brandUrl,
    });
    const summary = brandKit.brand_voice_summary || '';
    // Primary regression: no raw `&#x27;`, no `& x27;` artifact, no `&#`.
    assert.doesNotMatch(summary, /&#x?[0-9a-f]+;/i, 'should not contain raw numeric entity');
    assert.doesNotMatch(summary, /&\s*x27\s*;?/i, 'should not contain the broken "& x27;" artifact');
    assert.doesNotMatch(summary, /&#/, 'should not contain raw entity prefix');
    // Positive: hex apostrophe and named mdash should both be decoded.
    assert.ok(summary.includes("world's"), `expected decoded apostrophe in summary, got: ${summary}`);
    assert.ok(summary.includes('\u2014'), `expected decoded em-dash in summary, got: ${summary}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
