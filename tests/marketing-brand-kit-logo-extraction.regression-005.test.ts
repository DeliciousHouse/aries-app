// Regression: ISSUE-005 — "Logo candidates" section on /onboarding/start
// Step 4 rendered the page title ("Nike. Just Do It. Nike.com") as repeated
// text because extractLogoUrls returned an empty array for sites whose only
// brand mark was an inline <svg class="logo"> inside <nav>/<header>,
// leaving the frontend's placeholder fallback to be overwritten upstream.
//
// Fix: extractor now scans (a) inline SVGs with logo/brand class inside
// header/nav containers (emitted as data: URIs), (b) <link rel=icon>
// favicons and og:image as fallback candidates, and (c) <img> tags with
// className signals — in addition to the existing alt/src/filename checks.
//
// Found by /qa on 2026-04-20 against https://aries.sugarandleather.com.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

resolveProjectRoot(import.meta.url);

function createFetchResponse(body: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

function installHtmlFetchMock(brandUrl: string, html: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    if (url === brandUrl) return createFetchResponse(html);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test('extractBrandKitFromWebsite surfaces an inline <nav><svg class="logo"> as a data: URL candidate', async () => {
  const brandUrl = 'https://nav-svg-logo.example';
  const restore = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head><title>Nav SVG Co</title></head>
      <body>
        <nav>
          <svg class="logo" viewBox="0 0 100 40" aria-label="Nav SVG Co logo">
            <path d="M10 10h80v20H10z" fill="#111"/>
          </svg>
          <a href="/shop">Shop</a>
        </nav>
      </body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'nav-svg', brandUrl });
    assert.ok(brandKit.logo_urls.length > 0, 'expected at least one logo candidate');
    const svgCandidate = brandKit.logo_urls.find((url) => url.startsWith('data:image/svg+xml'));
    assert.ok(svgCandidate, `expected a data:image/svg+xml candidate, got: ${brandKit.logo_urls.join(', ')}`);
    // The raw SVG payload must be recoverable from the data URL so the
    // frontend <img src> can render it.
    const decoded = decodeURIComponent(svgCandidate.replace(/^data:image\/svg\+xml;utf8,/, ''));
    assert.match(decoded, /<svg\b/, 'data URL should contain <svg>');
    assert.match(decoded, /class="logo"/, 'data URL should preserve the logo class');
    assert.match(decoded, /<path\b/, 'data URL should include inline path');
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite surfaces <link rel=icon> favicons as a fallback candidate', async () => {
  const brandUrl = 'https://favicon-fallback.example';
  const restore = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head>
        <title>Favicon Fallback Co</title>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body><h1>Favicon Fallback Co</h1></body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'favicon-fallback', brandUrl });
    assert.ok(
      brandKit.logo_urls.includes('https://favicon-fallback.example/favicon.ico'),
      `expected resolved favicon URL, got: ${JSON.stringify(brandKit.logo_urls)}`,
    );
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite falls back to og:image when no higher-signal logo exists', async () => {
  const brandUrl = 'https://og-fallback.example';
  const restore = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head>
        <title>Og Fallback Co</title>
        <meta property="og:image" content="/og/share-card.png" />
      </head>
      <body><h1>Og Fallback Co</h1></body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'og-fallback', brandUrl });
    assert.ok(
      brandKit.logo_urls.includes('https://og-fallback.example/og/share-card.png'),
      `expected resolved og:image URL in fallback, got: ${JSON.stringify(brandKit.logo_urls)}`,
    );
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite prefers explicit-signal <img> logos over favicon/og fallbacks', async () => {
  const brandUrl = 'https://explicit-signal.example';
  const restore = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head>
        <title>Explicit Signal Co</title>
        <meta property="og:image" content="/og/share.png" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        <header>
          <img src="/assets/brand-logo.svg" alt="Explicit Signal Co logo" class="site-logo" />
        </header>
      </body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'explicit-signal', brandUrl });
    assert.equal(brandKit.logo_urls[0], 'https://explicit-signal.example/assets/brand-logo.svg');
    // Fallback candidates must not leak in when an explicit-signal logo wins.
    assert.equal(brandKit.logo_urls.includes('https://explicit-signal.example/favicon.ico'), false);
    assert.equal(brandKit.logo_urls.includes('https://explicit-signal.example/og/share.png'), false);
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite returns empty logo_urls when no logo-like assets exist', async () => {
  const brandUrl = 'https://no-logo.example';
  const restore = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head><title>No Logo Co</title></head>
      <body>
        <h1>No Logo Co</h1>
        <p>We have no branded imagery on this page.</p>
      </body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'no-logo', brandUrl });
    assert.deepEqual(brandKit.logo_urls, [], `expected empty logo_urls, got: ${JSON.stringify(brandKit.logo_urls)}`);
  } finally {
    restore();
  }
});
