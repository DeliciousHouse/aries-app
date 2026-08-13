/**
 * tests/insights-weekly-recap-print.test.ts
 *
 * S8-3 / AA-126 (gap F2b) — the print-ready weekly report: the cheap PDF path,
 * where Cmd+P yields a client-ready document.
 *
 * RELOCATED. AA-229/PR2b (#998) retired /dashboard/results and moved this
 * report onto /insights as Section 10 (WeeklyRecapSection). That move changes
 * what "print this report" has to mean: the report is no longer alone on its
 * page, it is one section among ten, so the print stylesheet must now also drop
 * the other nine. Otherwise Cmd+P produces the whole dashboard — hero, filters,
 * goal, trends, every panel — which is not a document anyone would send a
 * client. That sibling-hiding rule is the substantive addition here.
 *
 * HONEST LIMIT OF THIS FILE. Print output is decided by a rendering engine, and
 * neither jsdom nor a source regex evaluates `@media print`. These tests pin the
 * markup contract (the hooks the stylesheet keys on exist, on the right
 * elements) and the stylesheet contract (each hazard has a rule, every rule is
 * scoped). Nothing here should be read as proof that the printed page looks
 * right.
 *
 * That proof was obtained separately by driving real Chrome with
 * `Emulation.setEmulatedMedia({ media: 'print' })` and reading COMPUTED styles.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-weekly-recap-print.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { installJsdom } from './helpers/jsdom-env';

installJsdom();
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as Record<string, unknown>).self ??= globalThis;

import React from 'react';
import { WeeklyRecapSection } from '../frontend/insights/WeeklyRecapSection';
import { __resetInsightInflightForTests } from '../frontend/insights/useInsight';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const GLOBALS_CSS = readFileSync(path.join(PROJECT_ROOT, 'app', 'globals.css'), 'utf8');
const SECTION = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'insights', 'WeeklyRecapSection.tsx'),
  'utf8',
);
const DASHBOARD = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'insights', 'InsightsDashboard.tsx'),
  'utf8',
);

/** Enough of a report to render every branch the printout carries. */
const REPORT = {
  week: { iso: '2026-W32', startYmd: '2026-08-03', endYmd: '2026-08-09', label: 'Aug 3–9' },
  published: { total: 7, byChannel: { facebook: 4, instagram: 3 }, bySurface: { feed: 7 } },
  skipped: { total: 1, note: 'One post never left the queue.' },
  blocked: { total: 2, failedCount: 2, reconnect: true, reconnectChannels: ['facebook'] },
  needsReconciliation: { total: 1 },
  topChannel: { channel: 'facebook', value: 12400, basis: 'reach' },
  insightsConnected: true,
  learnings: [{ id: 'l1', title: 'Carousels outperformed', body: 'Two of the top three were carousels.' }],
  nextAction: { title: 'Post two carousels next week', body: 'Lean into what worked.', href: '/insights' },
};

const originalFetch = globalThis.fetch;
test.beforeEach(() => __resetInsightInflightForTests());
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetInsightInflightForTests();
});

/**
 * The section fetches its own data (it no longer takes a `report` prop), so the
 * only way to render it is through a stubbed endpoint.
 */
async function renderSection(props: Record<string, unknown> = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ enabled: true, report: REPORT }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(WeeklyRecapSection, props as never));
    await new Promise((r) => setTimeout(r, 10));
  });
  return root;
}

/** Visible text under a node — JSON.stringify walks into fiber internals and throws. */
function textOf(node: { children: unknown[] }): string {
  const out: string[] = [];
  const walk = (children: unknown[]) => {
    for (const child of children) {
      if (typeof child === 'string') out.push(child);
      else if (child && typeof child === 'object' && 'children' in child) {
        walk((child as { children: unknown[] }).children ?? []);
      }
    }
  };
  walk(node.children ?? []);
  return out.join(' ');
}

/** The print block, isolated so an unrelated rule cannot satisfy an assertion. */
function printBlock(): string {
  const at = GLOBALS_CSS.indexOf('S8-3 / AA-126');
  assert.ok(at > 0, 'the AA-126 print block must be present in globals.css');
  return GLOBALS_CSS.slice(at);
}

// ── Markup contract ──────────────────────────────────────────────────────────

test('the recap section carries the marker every print rule is scoped to', async () => {
  // Remove it and the whole stylesheet silently stops applying — Cmd+P goes
  // back to printing white text on white paper, with no error anywhere.
  const root = await renderSection();
  assert.ok(
    root.root.findAll((n) => n.props?.['data-print-report'] !== undefined).length > 0,
    'the section must carry data-print-report',
  );
});

test('the printout has a masthead that only appears on paper', async () => {
  const root = await renderSection();
  const header = root.root.findByProps({ 'data-testid': 'weekly-recap-print-header' });

  assert.match(String(header.props.className), /\bhidden\b/, 'hidden on screen');
  assert.match(String(header.props.className), /print:block/, 'shown in print');

  const text = textOf(header);
  assert.match(text, /Aries AI/);
  assert.match(text, /Aug 3–9/, 'names the week it covers');
  assert.match(text, /2026-08-03/, 'and the exact dates, not just a label');
});

test('the Print control triggers printing and never prints itself', async () => {
  let printed = 0;
  const root = await renderSection({ onPrint: () => { printed += 1; } });
  const button = root.root.findByProps({ 'data-testid': 'weekly-recap-print-button' });

  assert.equal(button.props['data-print-hidden'], true, 'excluded from the printout');
  button.props.onClick();
  assert.equal(printed, 1, 'clicking must invoke the print path');
});

test('the week stepper is excluded from the printout', async () => {
  // Arrows are things you click; on paper a disabled arrow reads as a rendering
  // fault rather than a control.
  const root = await renderSection();
  const hidden = root.root
    .findAll((n) => n.props?.['data-print-hidden'] !== undefined)
    .map((n) => textOf(n));

  assert.ok(hidden.some((t) => t.includes('‹') && t.includes('›')), 'the stepper must be print-hidden');
  assert.ok(hidden.some((t) => /Print \/ Save as PDF/.test(t)), 'and the print button itself');
});

test('the numbers a client reads survive into the printout', async () => {
  // A print stylesheet that hides too much is as broken as one that hides too
  // little. These are the figures the report exists to communicate.
  const root = await renderSection();
  const rendered = JSON.stringify(root.toJSON());

  for (const needle of ['Carousels outperformed', 'Facebook']) {
    assert.ok(rendered.includes(needle), `${needle} must survive into the printed report`);
  }
});

// ── Stylesheet contract ──────────────────────────────────────────────────────

test('printing /insights yields the recap, not the whole dashboard', () => {
  // The substantive consequence of AA-229/PR2b: the report gained nine
  // siblings. Without this rule Cmd+P produces every section on the page.
  const block = printBlock();
  assert.match(
    block,
    /\.insights-print-page > \*:not\(\[data-print-report\]\):not\(:has\(\[data-print-report\]\)\)/,
    'siblings of the report must be hidden',
  );
  assert.match(DASHBOARD, /className="insights-print-page"/, 'the section column must carry the hook');
  // The :not(:has(…)) half is load-bearing: without it, a wrapper that CONTAINS
  // the report would be hidden along with the report inside it.
  assert.match(block, /:not\(:has\(\[data-print-report\]\)\)/);
});

test('the dashboard\'s inline dark canvas is neutralised', () => {
  // .insights-surface paints its background via an INLINE style, which no
  // stylesheet rule outranks without !important — it is the one dark background
  // that would otherwise survive onto the page.
  assert.match(
    printBlock(),
    /body:has\(\[data-print-report\]\) \.insights-surface \{\s*background:\s*#fff\s*!important/,
  );
});

test('the dark theme is inverted, or the report prints white on white', () => {
  const block = printBlock();
  assert.match(
    block,
    /body:has\(\[data-print-report\]\)[^{]*\{[^}]*background:\s*#fff\s*!important[^}]*color:\s*#111\s*!important/,
    'the page itself must be white paper with dark ink',
  );
  assert.match(
    block,
    /\[data-print-report\] \*\s*\{[^}]*color:\s*#111\s*!important/,
    'every descendant must be re-inked',
  );
  assert.match(block, /backdrop-filter:\s*none/);
  assert.match(block, /box-shadow:\s*none/);
});

test('the overflow containers are unclipped, or the PDF is one cut-off page', () => {
  const block = printBlock();
  assert.match(block, /overflow:\s*visible\s*!important/);
  assert.match(block, /main\s*\*/, 'the inner scroller must be unclipped too');
  assert.match(block, /padding-left:\s*0\s*!important/, 'the sidebar indent must go');
});

test('animation state cannot leave the page blank', () => {
  const block = printBlock();
  assert.match(block, /opacity:\s*1\s*!important/);
  assert.match(block, /transform:\s*none\s*!important/);
  assert.match(block, /animation:\s*none\s*!important/);
});

test('cards do not split across a page break', () => {
  const block = printBlock();
  assert.match(block, /break-inside:\s*avoid/);
  assert.match(block, /page-break-inside:\s*avoid/, 'the legacy property, for older engines');
});

test('outbound permalinks print their URL', () => {
  const block = printBlock();
  assert.match(block, /a\[href\^="http"\]::after/, 'only outbound links, not in-app hrefs');
  assert.match(block, /content:\s*" \(" attr\(href\) "\)"/);
});

test('the print rules live in globals.css, not a component-imported stylesheet', () => {
  // globals.css is imported once by the root layout, so a scoped block there
  // costs nothing; a component-level import would be global by accident — which
  // is exactly the insights.css leak AA-128 had to undo.
  assert.doesNotMatch(SECTION, /import\s+['"].*\.css['"]/, 'no stylesheet import in the section');
  assert.match(printBlock(), /@media print/);
});
