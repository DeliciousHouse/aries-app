/**
 * Brand-color extraction must capture a site's dark/light theme.
 *
 * Bug (found via live E2E, 2026-06-02): aries.sugarandleather.com is a
 * `bg-black` Tailwind site, but extractBrandColors only read inline colors,
 * CSS `--brand/--primary` vars, and the theme-color meta — none of which the
 * site sets — so it returned `primary:#ffffff` and the marketing pipeline
 * rendered every image on a WHITE background. The fix adds dark/light theme
 * detection (Tailwind bg-* utilities on <body>/<html> or dominant across the
 * markup, inline body background, body{}/:root CSS, theme-color) that records
 * `colors.background` + `colors.mode` so the image brief can render on-brand.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/brand-kit-dark-theme.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectRoot } from '../helpers/project-root';

resolveProjectRoot(import.meta.url);

function installHtmlFetchMock(
  brandUrl: string,
  html: string,
  cssByUrl: Record<string, string> = {},
): { restore: () => void; fetchImpl: typeof fetch } {
  const originalFetch = globalThis.fetch;
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === brandUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (cssByUrl[url]) {
      return new Response(cssByUrl[url], { status: 200, headers: { 'content-type': 'text/css' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = fakeFetch as typeof globalThis.fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, fetchImpl: fakeFetch };
}

test('extractBrandKitFromWebsite detects a bg-black site as dark', async () => {
  const brandUrl = 'https://dark-brand.example';
  // Mirror an Aries-style App Router page: bg-black on <body>, accent magenta
  // only as a utility/inline accent. No theme-color, no --brand var.
  const { restore, fetchImpl } = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html lang="en">
      <head><title>Aries AI</title></head>
      <body class="bg-black text-white antialiased">
        <header class="bg-black"><h1 style="color:#ec4899">Aries AI</h1></header>
        <main class="bg-black"><section class="bg-zinc-950">Marketing on autopilot.</section></main>
      </body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'dark-theme', brandUrl, fetchImpl });
    assert.equal(brandKit.colors.mode, 'dark', `expected dark mode, got ${brandKit.colors.mode}`);
    assert.equal(brandKit.colors.background, '#000000', `expected #000000 background, got ${brandKit.colors.background}`);
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite detects a bg-white site as light', async () => {
  const brandUrl = 'https://light-brand.example';
  const { restore, fetchImpl } = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head><title>Lumen Co</title></head>
      <body class="bg-white text-slate-900">
        <h1 style="color:#1d4ed8">Lumen Co</h1>
        <p>Bright and clean.</p>
      </body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'light-theme', brandUrl, fetchImpl });
    assert.equal(brandKit.colors.mode, 'light', `expected light mode, got ${brandKit.colors.mode}`);
    assert.equal(brandKit.colors.background, '#ffffff', `expected #ffffff background, got ${brandKit.colors.background}`);
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite resolves a Tailwind v4 --color-background and ignores bg-white/N glass overlays (the aries.sugarandleather.com shape)', async () => {
  // Real-world regression: the page background is `bg-background` → the CSS var
  // --color-background (#050505, dark) defined in an external stylesheet, while
  // the visible UI is full of translucent `bg-white/5` glass overlays on top of
  // the dark theme. The naive "count bg-* utilities" heuristic mis-picked
  // bg-white (the overlays) and reported a light/#ffffff brand. The fix reads
  // the CSS token first and excludes opacity-qualified utilities.
  const brandUrl = 'https://aries-shape.example';
  const cssUrl = 'https://aries-shape.example/theme.css';
  const { restore, fetchImpl } = installHtmlFetchMock(
    brandUrl,
    `<!doctype html>
    <html lang="en">
      <head><title>Aries AI</title><link rel="stylesheet" href="/theme.css"></head>
      <body class="inter_variable manrope_variable">
        <div class="relative min-h-screen bg-background selection:bg-primary/30">
          <nav class="bg-white/5 border border-white/10">menu</nav>
          <header class="bg-black"><h1>Aries AI</h1></header>
          <section class="bg-white/5"><div class="bg-white/10">glass card</div></section>
          <section class="bg-white/5">more glass</section>
        </div>
      </body>
    </html>`,
    { [cssUrl]: ':root{--color-background:#050505;--color-primary:#7c3aed;--color-secondary:#a855f7;--color-accent:#c084fc}' },
  );

  try {
    const { extractBrandKitFromWebsite } = await import('../../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'aries-shape', brandUrl, fetchImpl });
    assert.equal(brandKit.colors.mode, 'dark', `expected dark mode, got ${brandKit.colors.mode}`);
    assert.equal(brandKit.colors.background, '#050505', `expected #050505 background, got ${brandKit.colors.background}`);
    // The real purple brand palette must come through (Tailwind v4 --color-* tokens),
    // not the #ffffff that the overlays would have suggested.
    assert.ok(brandKit.colors.palette.includes('#7c3aed'), `palette must include the brand primary; got ${brandKit.colors.palette.join(', ')}`);
    assert.notEqual(brandKit.colors.primary, '#ffffff', 'primary must not be white for a dark purple brand');
  } finally {
    restore();
  }
});

test('extractBrandKitFromWebsite reads theme-color meta when no bg-* utility is present', async () => {
  const brandUrl = 'https://meta-theme.example';
  const { restore, fetchImpl } = installHtmlFetchMock(brandUrl, `<!doctype html>
    <html>
      <head><title>Midnight Labs</title><meta name="theme-color" content="#0a0a0a"></head>
      <body><h1>Midnight Labs</h1></body>
    </html>`);

  try {
    const { extractBrandKitFromWebsite } = await import('../../backend/marketing/brand-kit');
    const brandKit = await extractBrandKitFromWebsite({ tenantId: 'meta-theme', brandUrl, fetchImpl });
    assert.equal(brandKit.colors.background, '#0a0a0a', `expected #0a0a0a background, got ${brandKit.colors.background}`);
    assert.equal(brandKit.colors.mode, 'dark', `expected dark mode, got ${brandKit.colors.mode}`);
  } finally {
    restore();
  }
});
