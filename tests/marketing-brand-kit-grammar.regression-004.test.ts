// Regression: ISSUE-004 — scraped brand text had grammar artifacts where
// inline tags were stripped (e.g. `innovative<em>products</em>, experiences`
// became `innovative products , experiences` with an orphan ` , `).
//
// Root cause: `<[^>]+>` was being replaced with a space (correct, to keep
// adjacent words separated) but `normalizeWhitespace` did not subsequently
// collapse the resulting space-before-punctuation artifact.
//
// Found by /qa on 2026-04-20 against https://aries.sugarandleather.com
// Fix: cleanup pass in normalizeWhitespace to drop whitespace before
// `, . ; : ! ?` and collapse repeated commas.
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

test('extractBrandKitFromWebsite removes orphan space-comma after stripping inline tags', async () => {
  const originalFetch = globalThis.fetch;
  const brandUrl = 'https://nike-style.example';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    if (url === brandUrl) {
      return createFetchResponse(
        `<!doctype html>
        <html>
          <head>
            <title>Inline Tag Co</title>
            <meta name="description" content="Inspiring the world<em>'s</em> athletes, Nike delivers innovative<em> products</em>, experiences and services.">
          </head>
          <body>
            <h1>Inline Tag Co</h1>
            <p>Inspiring the world<em>'s</em> athletes, Nike delivers innovative<em>products</em>, experiences and services.</p>
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
      tenantId: 'inline-tag-co',
      brandUrl,
    });
    const summary = brandKit.brand_voice_summary || '';
    assert.doesNotMatch(summary, / , /, `should not contain orphan ' , ', got: ${summary}`);
    assert.doesNotMatch(summary, / \./, `should not contain ' .' (space-before-period), got: ${summary}`);
    assert.doesNotMatch(summary, /,\s*,/, `should not contain consecutive commas, got: ${summary}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeWhitespace cleans inline-tag-strip grammar artifacts (unit)', async () => {
  // We exercise the public path by importing sanitizeBrandKitSummaryText, which
  // funnels through the same normalize pass.
  const { sanitizeBrandKitSummaryText } = await import('../backend/marketing/brand-kit');

  // Case 1: tag adjacent to word, comma after the closing tag.
  const out1 = sanitizeBrandKitSummaryText('A<em>B</em>, C');
  assert.equal(out1, 'A B, C');

  // Case 2: leading space before tag — idempotent.
  const out2 = sanitizeBrandKitSummaryText('A <em>B</em>, C');
  assert.equal(out2, 'A B, C');

  // Case 3: Nike-style sentence. No orphan punctuation.
  const out3 = sanitizeBrandKitSummaryText(
    "Inspiring the world<em>'s</em> athletes, Nike delivers innovative<em> gear</em>, experiences and services."
  ) || '';
  assert.doesNotMatch(out3, / , /);
  assert.doesNotMatch(out3, / \./);
  assert.doesNotMatch(out3, /,\s*,/);
  assert.ok(out3.includes('innovative gear, experiences'),
    `expected 'innovative gear, experiences' in cleaned output, got: ${out3}`);

  // Case 4: legitimate URL with comma — comma preserved, no spaces removed
  // from inside the URL token.
  const out4 = sanitizeBrandKitSummaryText('See https://example.com/a,b for details');
  assert.equal(out4, 'See https://example.com/a,b for details');

  // Case 5: ellipsis preserved (three consecutive periods are not "space-dot").
  const out5 = sanitizeBrandKitSummaryText('Wait... it works');
  assert.equal(out5, 'Wait... it works');
});
