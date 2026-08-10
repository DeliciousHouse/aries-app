import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  CSV_BOM,
  csvField,
  csvFilename,
  csvRow,
  neutralizeFormula,
} from '../backend/insights/export/csv';
import {
  EXPORT_ACCOUNT_METRICS_HEADER,
  EXPORT_POSTS_HEADER,
  EXPORT_POSTS_SQL,
  MAX_EXPORT_POST_ROWS,
  REFUSED_DATASETS,
  clampInt,
  isExportDataset,
  loadAccountMetricsDataset,
  loadPostsDataset,
  type ExportQueryable,
} from '../backend/insights/export/export-datasets';
import { handleGetInsightsExport } from '../app/api/insights/export/route';
import { TenantContextError, type TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';

/**
 * S5-3 / AA-112 (gap F2a) — insights CSV export.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-export-csv.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const URL_BASE = 'https://aries.example.com/api/insights/export';

// ── CSV correctness ──────────────────────────────────────────────────────────

test('quotes fields containing a comma, quote, CR or LF', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
  assert.equal(csvField('line1\r\nline2'), '"line1\r\nline2"');
});

test('renders empties, numbers, booleans and dates predictably', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(0), '0', 'zero is a real value, not empty');
  assert.equal(csvField(12.5), '12.5');
  assert.equal(csvField(Number.NaN), '');
  assert.equal(csvField(Number.POSITIVE_INFINITY), '');
  assert.equal(csvField(true), 'true');
  assert.equal(csvField(new Date('2026-08-05T10:00:00Z')), '2026-08-05T10:00:00.000Z');
  assert.equal(csvField(new Date('nope')), '');
});

test('SECURITY: neutralizes spreadsheet formula injection', () => {
  // Captions come from public social platforms, so this is untrusted input
  // heading for an operator's Excel. A cell starting =, +, -, @, TAB or CR is
  // executed on open.
  for (const payload of [
    '=HYPERLINK("http://evil.example","click")',
    '+1+1',
    '-1+1',
    '@SUM(A1:A9)',
    '\tcmd',
    '\rcmd',
  ]) {
    const out = neutralizeFormula(payload);
    assert.equal(out[0], "'", `${JSON.stringify(payload)} must be neutralized`);
    assert.ok(out.endsWith(payload));
  }
  // Ordinary text is untouched.
  assert.equal(neutralizeFormula('Great post!'), 'Great post!');
  assert.equal(neutralizeFormula(''), '');

  // And it survives the full field render (quoted because of the comma).
  assert.equal(csvField('=cmd,x'), `"'=cmd,x"`);
});

test('rows use CRLF and the file leads with a UTF-8 BOM', () => {
  assert.equal(csvRow(['a', 'b']), 'a,b\r\n');
  assert.equal(CSV_BOM, '﻿');
});

test('filenames are date-stamped and shell/header safe', () => {
  const name = csvFilename('posts', new Date('2026-08-05T00:00:00Z'));
  assert.equal(name, 'insights-posts-2026-08-05.csv');
  assert.doesNotMatch(csvFilename('../../etc/passwd'), /[/\\.]{2}/);
  assert.match(csvFilename('account-metrics'), /^insights-account-metrics-\d{4}-\d{2}-\d{2}\.csv$/);
});

// ── Dataset contracts ────────────────────────────────────────────────────────

test('comments are refused BY NAME, not as an unknown dataset', () => {
  // The refusal must read as a deliberate product decision (commenter PII
  // leaving the app boundary), not as a typo.
  assert.ok(REFUSED_DATASETS.comments);
  assert.match(REFUSED_DATASETS.comments, /commenter/i);
  assert.equal(isExportDataset('comments'), false);
  assert.equal(isExportDataset('posts'), true);
  assert.equal(isExportDataset('account-metrics'), true);
  assert.equal(isExportDataset(null), false);
});

test('no exported column can carry commenter PII', () => {
  // Structural guard: even a future edit to the header lists cannot smuggle a
  // commenter field into an export.
  const forbidden = ['author', 'author_handle', 'body_text', 'commenter', 'comment_text'];
  for (const col of [...EXPORT_POSTS_HEADER, ...EXPORT_ACCOUNT_METRICS_HEADER]) {
    assert.ok(!forbidden.includes(col), `${col} must not be exported`);
  }
  // comments_count is an aggregate COUNT, not comment content — allowed.
  assert.ok(EXPORT_POSTS_HEADER.includes('comments_count'));
});

test('post metrics read the LATEST snapshot, never a SUM (S2-1 / "numbers are true")', () => {
  assert.match(EXPORT_POSTS_SQL, /LEFT JOIN LATERAL/);
  assert.match(EXPORT_POSTS_SQL, /ORDER BY d\.date DESC\s*\n?\s*LIMIT 1/);
  assert.doesNotMatch(EXPORT_POSTS_SQL, /SUM\s*\(/i);
  // Tenant-scoped and parameterized.
  assert.match(EXPORT_POSTS_SQL, /p\.tenant_id = \$1/);
  assert.match(EXPORT_POSTS_SQL, /LIMIT \$3/);
});

test('clampInt bounds every caller-supplied number', () => {
  assert.equal(clampInt(10, 1, 100), 10);
  assert.equal(clampInt(0, 1, 100), 1);
  assert.equal(clampInt(1e9, 1, 100), 100);
  assert.equal(clampInt(Number.NaN, 1, 100), 1);
  assert.equal(clampInt(-5, 1, 100), 1);
  assert.equal(clampInt(2.9, 1, 100), 2);
});

function fakeDb(rows: Record<string, unknown>[]): { db: ExportQueryable; values: unknown[][] } {
  const values: unknown[][] = [];
  return {
    values,
    db: {
      async query(_text: string, v?: unknown[]) {
        values.push(v ?? []);
        return { rows: rows as never[] };
      },
    },
  };
}

test('the post row cap is enforced regardless of the requested limit', async () => {
  const { db, values } = fakeDb([]);
  await loadPostsDataset(db, 7, null, 10_000_000);
  assert.deepEqual(values[0], [7, null, MAX_EXPORT_POST_ROWS]);
});

test('a full page is reported as truncated so it never reads as "all my data"', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ post_id: i }));
  const { db } = fakeDb(rows);
  const capped = await loadPostsDataset(db, 7, null, 3);
  assert.equal(capped.truncated, true);

  const under = await loadPostsDataset(fakeDb(rows).db, 7, null, 50);
  assert.equal(under.truncated, false);
});

test('dataset rows follow the declared header order exactly', async () => {
  const { db } = fakeDb([
    { post_id: 1, platform: 'instagram', reach: 100, caption: 'hi', comments_count: 4 },
  ]);
  const out = await loadPostsDataset(db, 7, 'instagram', 10);
  assert.deepEqual(out.header, EXPORT_POSTS_HEADER);
  assert.equal(out.rows[0][EXPORT_POSTS_HEADER.indexOf('post_id')], 1);
  assert.equal(out.rows[0][EXPORT_POSTS_HEADER.indexOf('platform')], 'instagram');
  assert.equal(out.rows[0][EXPORT_POSTS_HEADER.indexOf('reach')], 100);
  // A column with no value in the row becomes empty, not misaligned.
  assert.equal(out.rows[0][EXPORT_POSTS_HEADER.indexOf('permalink')], undefined);
  assert.equal(out.rows[0].length, EXPORT_POSTS_HEADER.length);
});

test('account-metrics dataset is tenant + window + platform scoped', async () => {
  const { db, values } = fakeDb([]);
  await loadAccountMetricsDataset(db, 7, '2026-05-07', 'facebook');
  assert.deepEqual(values[0], [7, '2026-05-07', 'facebook']);
});

// ── Route ────────────────────────────────────────────────────────────────────

function tenantLoader(tenantId: string): TenantContextLoader {
  return async () =>
    ({ tenantId, tenantSlug: 't', userId: 'u', role: 'tenant_admin' }) as unknown as TenantContext;
}

test('unauthenticated export is refused', async () => {
  const res = await handleGetInsightsExport(new Request(`${URL_BASE}?dataset=posts`), async () => {
    throw new Error('Authentication required.');
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'tenant_context_required');
});

test('a membership-less session cannot export another tenant’s data', async () => {
  const res = await handleGetInsightsExport(new Request(`${URL_BASE}?dataset=posts`), async () => {
    throw new TenantContextError('tenant_membership_missing', 'none');
  });
  assert.equal(res.status, 403);
});

test('dataset=comments is refused with the PII reason before any DB work', async () => {
  const res = await handleGetInsightsExport(
    new Request(`${URL_BASE}?dataset=comments`),
    tenantLoader('7'),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.reason, 'dataset_not_exportable');
  assert.match(String(body.message), /commenter/i);
});

test('an unknown or missing dataset is a 400, not a default export', async () => {
  for (const qs of ['', '?dataset=', '?dataset=everything']) {
    const res = await handleGetInsightsExport(new Request(`${URL_BASE}${qs}`), tenantLoader('7'));
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).reason, 'unknown_dataset');
  }
});

test('a non-numeric tenant is refused rather than coerced', async () => {
  const res = await handleGetInsightsExport(
    new Request(`${URL_BASE}?dataset=posts`),
    tenantLoader('not-a-number'),
  );
  assert.equal(res.status, 403);
});

// ── Source-level contracts ───────────────────────────────────────────────────

const routeSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'api', 'insights', 'export', 'route.ts'),
  'utf8',
);

test('the pooled client is released BEFORE the response streams', () => {
  // A slow download must never pin a DB connection (guardrail #1). The release
  // has to happen before the ReadableStream is constructed, not in a finally
  // that runs after streaming.
  const releaseAt = routeSource.indexOf('client.release()');
  const streamAt = routeSource.indexOf('new ReadableStream');
  assert.ok(releaseAt > 0 && streamAt > 0);
  assert.ok(releaseAt < streamAt, 'client.release() must precede the stream');
});

test('the export is tenant-scoped from context and never cached', () => {
  assert.match(routeSource, /tenantResult\.tenantContext\.tenantId/);
  assert.doesNotMatch(
    routeSource,
    /searchParams\.get\(\s*['"](tenant|tenantId|tenant_id|organizationId)['"]\s*\)/i,
  );
  assert.match(routeSource, /'cache-control':\s*'no-store'/);
  assert.match(routeSource, /content-disposition/);
});

test('the export is read-only', () => {
  assert.doesNotMatch(routeSource, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(routeSource, /export async function (POST|PUT|PATCH|DELETE)/);
});

test('the /insights control row offers the download and omits comments', () => {
  const dashboard = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'insights', 'InsightsDashboard.tsx'),
    'utf8',
  );
  assert.match(dashboard, /<ExportMenu period=\{period\} platform=\{platform\}/);

  const menu = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'insights', 'ExportMenu.tsx'),
    'utf8',
  );
  // Assert the actual dataset call sites, not any mention — the file's header
  // deliberately explains why comments are absent.
  assert.match(menu, /exportHref\("posts"/);
  assert.match(menu, /exportHref\("account-metrics"/);
  assert.doesNotMatch(
    menu,
    /exportHref\("comments"|dataset=comments/,
    'the UI must not offer a comments export',
  );
  // And it must pass the live filters through, so the file matches the screen.
  assert.match(menu, /params\.set\("platform", platform\)/);
});
