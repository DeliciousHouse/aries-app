import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function withTempDir(name: string, run: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), name));
  try {
    run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeSearchMock(tempDir: string, results: SearchResult[]): string {
  const searchPath = path.join(tempDir, 'mock-search.sh');
  writeFileSync(
    searchPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ results })}'`,
    ].join('\n'),
    'utf8',
  );
  chmodSync(searchPath, 0o755);
  return searchPath;
}

function writeHtmlFixture(tempDir: string, name: string, html: string): string {
  const fixturePath = path.join(tempDir, name);
  writeFileSync(fixturePath, html, 'utf8');
  return fixturePath;
}

function runExtractor(input: {
  tempDir: string;
  args: string[];
  searchResults: SearchResult[];
  siteHtml?: string;
  env?: Record<string, string>;
}) {
  const searchPath = writeSearchMock(input.tempDir, input.searchResults);
  const siteFixturePath = input.siteHtml
    ? writeHtmlFixture(input.tempDir, 'site.html', input.siteHtml)
    : '';

  return spawnSync(
    'python3',
    [path.join(PROJECT_ROOT, 'lobster/bin/meta-ads-extractor'), '--json', ...input.args],
    {
      env: {
        ...process.env,
        LOBSTER_WEB_SEARCH_CMD: searchPath,
        LOBSTER_STAGE1_CACHE_DIR: path.join(input.tempDir, 'cache'),
        ...(siteFixturePath ? { LOBSTER_STAGE1_SITE_HTML_FIXTURE: siteFixturePath } : {}),
        GEMINI_API_KEY: '',
        ...(input.env ?? {}),
      },
      encoding: 'utf8',
    },
  );
}

const BETTERUP_SITE_HTML = `<!doctype html>
<html>
  <head>
    <title>BetterUp | Human transformation at work</title>
    <meta name="description" content="BetterUp helps leaders and teams grow through coaching and performance support." />
  </head>
  <body>
    <h1>BetterUp</h1>
    <a href="https://www.facebook.com/betterupco">BetterUp on Facebook</a>
    <a href="https://betterup.com/leadership-coaching">Leadership coaching</a>
  </body>
</html>`;

const MINDVALLEY_SITE_HTML = `<!doctype html>
<html>
  <head>
    <title>Mindvalley | Transform the way you learn</title>
    <meta name="description" content="Mindvalley offers programs, events, and classes for personal growth." />
  </head>
  <body>
    <h1>Mindvalley</h1>
    <a href="https://www.facebook.com/mindvalley">Mindvalley on Facebook</a>
  </body>
</html>`;

const TONY_ROBBINS_SITE_HTML = `<!doctype html>
<html>
  <head>
    <title>Tony Robbins | Events, coaching, and business mastery</title>
    <meta name="description" content="Tony Robbins offers live events, coaching, and business programs." />
  </head>
  <body>
    <h1>Tony Robbins</h1>
    <a href="https://www.facebook.com/TonyRobbins">Tony Robbins on Facebook</a>
  </body>
</html>`;

test('meta-ads-extractor reports configured Meta env flags without exposing raw ids', () => {
  withTempDir('meta-ads-extractor-config-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: ['--competitor-url', 'https://betterup.com'],
      searchResults: [
        {
          title: 'BetterUp coaching',
          url: 'https://betterup.com/leadership-coaching',
          snippet: 'BetterUp leadership coaching for managers and teams.',
        },
      ],
      siteHtml: BETTERUP_SITE_HTML,
      env: {
        META_ACCESS_TOKEN: 'secret-value',
        META_AD_ACCOUNT_ID: '123456789',
        META_PAGE_ID: '',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { meta_config: Record<string, unknown> };
    assert.deepEqual(payload.meta_config, {
      has_access_token: true,
      has_ad_account_id: true,
      has_page_id: false,
    });
  });
});

test('meta-ads-extractor keeps betterup.com as the canonical domain and discovers Meta locators internally', () => {
  withTempDir('meta-ads-extractor-betterup-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: ['--competitor-url', 'https://betterup.com'],
      searchResults: [
        {
          title: 'BetterUp leadership coaching',
          url: 'https://betterup.com/leadership-coaching',
          snippet: 'BetterUp leadership coaching helps teams improve performance.',
        },
        {
          title: 'BetterUp Facebook page',
          url: 'https://www.facebook.com/betterupco',
          snippet: 'Official BetterUp Facebook page.',
        },
      ],
      siteHtml: BETTERUP_SITE_HTML,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as Record<string, any>;

    assert.equal(payload.competitor_url, 'https://betterup.com');
    assert.equal(payload.competitorIdentity.canonicalDomain, 'betterup.com');
    assert.equal(payload.metaLocator.facebookPageUrl, 'https://www.facebook.com/betterupco');
    assert.match(String(payload.metaLocator.metaPageId), /betterupco/i);
    assert.ok(['trusted', 'probable', 'override'].includes(payload.trustValidation.classification));
    assert.equal(payload.competitorIdentity.canonicalDomain, 'betterup.com');
    assert.equal((result.stderr || '').includes('facebook.com'), true);
    assert.doesNotMatch(result.stderr || result.stdout, /stage1_competitor_domain_mismatch:no_trustworthy_same_domain_evidence:facebook\.com/);
  });
});

test('meta-ads-extractor supports mindvalley.com with internal discovery', () => {
  withTempDir('meta-ads-extractor-mindvalley-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: ['--competitor-url', 'https://mindvalley.com'],
      searchResults: [
        {
          title: 'Mindvalley memberships',
          url: 'https://mindvalley.com/programs',
          snippet: 'Mindvalley programs and memberships for personal growth.',
        },
        {
          title: 'Mindvalley on Facebook',
          url: 'https://www.facebook.com/mindvalley',
          snippet: 'Official Mindvalley page.',
        },
      ],
      siteHtml: MINDVALLEY_SITE_HTML,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.competitorIdentity.canonicalDomain, 'mindvalley.com');
    assert.ok(['trusted', 'probable', 'override'].includes(payload.trustValidation.classification));
    assert.equal(payload.metaLocator.facebookPageUrl, 'https://www.facebook.com/mindvalley');
  });
});

test('meta-ads-extractor accepts branded subdomain evidence for tonyrobbins.com', () => {
  withTempDir('meta-ads-extractor-tonyrobbins-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: ['--competitor-url', 'https://tonyrobbins.com'],
      searchResults: [
        {
          title: 'Tony Robbins live events',
          url: 'https://events.tonyrobbins.com/unleash-the-power-within',
          snippet: 'Tony Robbins events and coaching experiences.',
        },
      ],
      siteHtml: TONY_ROBBINS_SITE_HTML,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.competitorIdentity.canonicalDomain, 'tonyrobbins.com');
    assert.ok(['trusted', 'probable', 'override'].includes(payload.trustValidation.classification));
    assert.ok((payload.evidence.ctaDomains as string[]).some((domain) => domain.includes('tonyrobbins.com')));
  });
});

test('meta-ads-extractor preserves the competitor website as canonical when a Facebook override is supplied', () => {
  withTempDir('meta-ads-extractor-facebook-override-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: [
        '--competitor-url',
        'https://betterup.com',
        '--facebook-page-url',
        'https://www.facebook.com/betterupco',
      ],
      searchResults: [
        {
          title: 'BetterUp leadership coaching',
          url: 'https://betterup.com/leadership-coaching',
          snippet: 'BetterUp leadership coaching helps teams improve performance.',
        },
      ],
      siteHtml: BETTERUP_SITE_HTML,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.competitorIdentity.canonicalDomain, 'betterup.com');
    assert.equal(payload.metaLocator.facebookPageUrl, 'https://www.facebook.com/betterupco');
  });
});

test('meta-ads-extractor preserves the competitor website as canonical when an Ad Library override is supplied', () => {
  withTempDir('meta-ads-extractor-ad-library-override-', (tempDir) => {
    const adLibraryUrl = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=118064144930466&category=all';
    const result = runExtractor({
      tempDir,
      args: [
        '--competitor-url',
        'https://betterup.com',
        '--ad-library-url',
        adLibraryUrl,
      ],
      searchResults: [
        {
          title: 'BetterUp leadership coaching',
          url: 'https://betterup.com/leadership-coaching',
          snippet: 'BetterUp leadership coaching helps teams improve performance.',
        },
      ],
      siteHtml: BETTERUP_SITE_HTML,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.competitorIdentity.canonicalDomain, 'betterup.com');
    assert.equal(payload.metaLocator.adLibraryUrl, adLibraryUrl);
  });
});

test('meta-ads-extractor rejects Facebook page URLs in competitor_url', () => {
  withTempDir('meta-ads-extractor-invalid-facebook-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: ['--competitor-url', 'https://www.facebook.com/betterupco'],
      searchResults: [
        {
          title: 'BetterUp Facebook page',
          url: 'https://www.facebook.com/betterupco',
          snippet: 'Official BetterUp page.',
        },
      ],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /competitor_url must be the competitor's website, not a Facebook or Ad Library URL/);
  });
});

test('meta-ads-extractor rejects Ad Library URLs in competitor_url', () => {
  withTempDir('meta-ads-extractor-invalid-ad-library-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: [
        '--competitor-url',
        'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&search_type=page&view_all_page_id=118064144930466&category=all',
      ],
      searchResults: [
        {
          title: 'BetterUp ads library',
          url: 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&search_type=page&view_all_page_id=118064144930466&category=all',
          snippet: 'BetterUp ads library page.',
        },
      ],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /competitor_url must be the competitor's website, not a Facebook or Ad Library URL/);
  });
});

test('meta-ads-extractor fails cleanly when explicit Meta overrides conflict with the canonical competitor', () => {
  withTempDir('meta-ads-extractor-conflict-', (tempDir) => {
    const result = runExtractor({
      tempDir,
      args: [
        '--competitor-url',
        'https://betterup.com',
        '--facebook-page-url',
        'https://www.facebook.com/sugarandleather',
        '--ad-library-url',
        'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&search_type=page&view_all_page_id=999999999&category=all',
      ],
      searchResults: [
        {
          title: 'BetterUp leadership coaching',
          url: 'https://betterup.com/leadership-coaching',
          snippet: 'BetterUp leadership coaching helps teams improve performance.',
        },
      ],
      siteHtml: BETTERUP_SITE_HTML,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /competitor trust classification: untrusted/);
    assert.match(result.stderr || result.stdout, /explicit Meta locator override conflicts with canonical competitor evidence/);
  });
});
