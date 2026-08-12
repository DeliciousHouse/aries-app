/**
 * tests/weekly-results-print.test.ts
 *
 * S8-3 / AA-126 (gap F2b) — the print-ready weekly report: the cheap PDF path,
 * where Cmd+P on /dashboard/results yields a client-ready document.
 *
 * HONEST LIMIT OF THIS FILE. Print output is decided by a rendering engine, and
 * neither jsdom nor a source regex evaluates `@media print`. So these tests pin
 * the two things that CAN be checked hermetically — the markup contract (the
 * hooks the stylesheet keys on actually exist and are attached to the right
 * elements) and the stylesheet contract (each hazard has a rule, and every rule
 * is scoped) — and nothing here should be read as proof that the printed page
 * looks right.
 *
 * That proof was obtained separately, by driving real Chrome with
 * `Emulation.setEmulatedMedia({ media: 'print' })` and reading COMPUTED styles:
 * sidebar/backdrop/mobile-header/print-button all `display:none`, the print
 * masthead `block`, `<main>` and its scroller `overflow:visible` with the
 * sidebar indent gone, body background `rgb(255,255,255)`, report text
 * `rgb(17,17,17)`, panels white — plus a leak check with the marker removed,
 * where every rule went inert. That harness needs a browser, so it cannot live
 * in `verify`; these tests exist to stop the markup and the stylesheet drifting
 * apart afterwards, which is the realistic regression.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/weekly-results-print.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { installJsdom } from './helpers/jsdom-env';

installJsdom();
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// `next/link` reaches for `self` (via requestIdleCallback in use-intersection).
// In a browser `self === window`; the jsdom helper installs window/document but
// not this alias, and without it rendering the panel throws ReferenceError.
(globalThis as unknown as Record<string, unknown>).self ??= globalThis;

import React from 'react';
import { WeeklyResultsPanel } from '../frontend/aries-v1/weekly-results-report';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const GLOBALS_CSS = readFileSync(path.join(PROJECT_ROOT, 'app', 'globals.css'), 'utf8');
const COMPONENT = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'weekly-results-report.tsx'),
  'utf8',
);

/** Just enough of a report to render every branch the printout carries. */
const REPORT = {
  week: { iso: '2026-W32', startYmd: '2026-08-03', endYmd: '2026-08-09', label: 'Aug 3–9' },
  published: { total: 7, byChannel: { facebook: 4, instagram: 3 }, bySurface: { feed: 7 } },
  skipped: { total: 1, note: 'One post never left the queue.' },
  blocked: { total: 2, failedCount: 2, reconnect: true, reconnectChannels: ['facebook'] },
  needsReconciliation: { total: 1 },
  topChannel: { channel: 'facebook', value: 12400, basis: 'reach' },
  bestPost: {
    available: true,
    post: {
      title: 'Spring drop', platform: 'instagram',
      metricLabel: '4,200 reach', permalink: 'https://instagram.com/p/abc',
    },
  },
  weakestPost: {
    available: true,
    post: {
      title: 'Quiet Tuesday', platform: 'facebook',
      metricLabel: '210 reach', permalink: 'https://facebook.com/p/xyz',
    },
  },
  learnings: [{ id: 'l1', title: 'Carousels outperformed', body: 'Two of the top three were carousels.' }],
  nextAction: { title: 'Post two carousels next week', body: 'Lean into what worked.', href: '/dashboard' },
} as never;

async function renderPanel(props: Record<string, unknown> = {}) {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(WeeklyResultsPanel, { report: REPORT, ...props } as never));
  });
  return root;
}

/**
 * Visible text under a rendered node. `JSON.stringify` on a react-test-renderer
 * instance walks into fiber internals and throws on the circular reference, so
 * collect the strings explicitly.
 */
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

/** The print block, isolated so a rule elsewhere in globals.css cannot satisfy an assertion. */
function printBlock(): string {
  const marker = 'S8-3 / AA-126';
  const at = GLOBALS_CSS.indexOf(marker);
  assert.ok(at > 0, 'the AA-126 print block must be present in globals.css');
  return GLOBALS_CSS.slice(at);
}

// ── Markup contract ──────────────────────────────────────────────────────────

test('the report carries the marker every print rule is scoped to', async () => {
  // Remove this attribute and the whole stylesheet silently stops applying —
  // Cmd+P would go back to printing white text on white paper with no error.
  const root = await renderPanel();
  assert.ok(
    root.root.findAll((n) => n.props?.['data-print-report'] !== undefined).length > 0,
    'the panel root must carry data-print-report',
  );
});

test('the printout has a masthead that only appears on paper', async () => {
  // On screen the shell supplies the heading; on paper the reader needs to know
  // what this document is, which week it covers, and when it was produced.
  const root = await renderPanel();
  const header = root.root.findByProps({ 'data-testid': 'weekly-results-print-header' });

  assert.match(String(header.props.className), /\bhidden\b/, 'hidden on screen');
  assert.match(String(header.props.className), /print:block/, 'shown in print');

  const text = textOf(header);
  assert.match(text, /Aries AI/);
  assert.match(text, /Aug 3–9/, 'names the week it covers');
  assert.match(text, /2026-08-03/, 'and the exact dates, not just a label');
});

test('the Print control triggers printing and never prints itself', async () => {
  let printed = 0;
  const root = await renderPanel({ onPrint: () => { printed += 1; } });
  const button = root.root.findByProps({ 'data-testid': 'weekly-results-print-button' });

  assert.equal(button.props['data-print-hidden'], true, 'the button must be excluded from the printout');
  button.props.onClick();
  assert.equal(printed, 1, 'clicking must invoke the print path');
});

test('in-app actions are excluded from the printout', async () => {
  // "Reconnect Meta" and "Take me there" are things you click. On a client's
  // desk they are dead ink that makes the report look like a screenshot.
  const root = await renderPanel();
  const hidden = root.root
    .findAll((n) => n.props?.['data-print-hidden'] !== undefined)
    .map((n) => textOf(n));

  assert.ok(hidden.some((c) => /Reconnect Meta/.test(c)), 'Reconnect Meta must be print-hidden');
  assert.ok(hidden.some((c) => /Take me there/.test(c)), 'the next-action CTA must be print-hidden');
  assert.ok(hidden.some((c) => /Print \/ Save as PDF/.test(c)), 'the print button itself');
});

test('the numbers a client reads survive into the printout', async () => {
  // A print stylesheet that hides too much is as broken as one that hides too
  // little. These are the figures the report exists to communicate.
  const root = await renderPanel();
  const rendered = JSON.stringify(root.toJSON());

  for (const needle of ['7 published', 'Facebook', 'Spring drop', '4,200 reach', 'Carousels outperformed']) {
    assert.ok(rendered.includes(needle), `${needle} must be in the printed report`);
  }
});

test('the live-posts roster is excluded, so the printout is a report not a screenshot', () => {
  // /dashboard/results renders the weekly report ABOVE the operating roster.
  // Printing both would hand a client several pages of app UI after the summary.
  const page = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'dashboard', 'results', 'page.tsx'),
    'utf8',
  );
  assert.match(
    page,
    /<div data-print-hidden>\s*<AriesResultsScreen \/>\s*<\/div>/,
    'the roster must be wrapped in a print-hidden container',
  );
  // …and only in the flag-on branch: with the flag off there is no report to
  // print, and the page must stay byte-identical to today.
  assert.match(page, /\) : \(\s*<AriesResultsScreen \/>\s*\)/, 'the flag-off branch is untouched');
});

// ── Stylesheet contract ──────────────────────────────────────────────────────

test('every print rule is scoped, so no other route is restyled', async () => {
  // insights.css leaked its body styles onto unrelated routes precisely because
  // a component-imported stylesheet is global (roadmap S8-5, still open). A
  // second global print block would be the same bug with a longer fuse.
  const block = printBlock();
  const selectors = block
    .split('\n')
    .filter((line) => /^\s*(body|main|aside|header|\[|\.|>|\w+[\s,{])/.test(line))
    .filter((line) => line.includes('{') || line.trim().endsWith(','))
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('@') && !line.startsWith('/*'));

  const unscoped = selectors.filter(
    (sel) => !sel.includes('data-print-report') && !sel.includes('print-hidden'),
  );
  assert.deepEqual(unscoped, [], `every selector must be scoped; unscoped: ${unscoped.join(' | ')}`);
});

test('the dark theme is inverted, or the report prints white on white', async () => {
  const block = printBlock();

  // Pin the PAGE-level rule specifically. A loose /color:\s*#111/ match passes
  // on the descendant rule further down, so deleting the page inversion would
  // sail through — which is exactly what a mutation run caught it doing.
  assert.match(
    block,
    /body:has\(\[data-print-report\]\)[^{]*\{[^}]*background:\s*#fff\s*!important[^}]*color:\s*#111\s*!important/,
    'the page itself must be white paper with dark ink',
  );
  // And the descendants, which carry the dozens of text-white/NN utilities.
  assert.match(
    block,
    /\[data-print-report\] \*\s*\{[^}]*color:\s*#111\s*!important/,
    'every descendant must be re-inked',
  );
  assert.match(block, /backdrop-filter:\s*none/, 'blur renders as grey mud');
  assert.match(block, /box-shadow:\s*none/);
});

test('the overflow containers are unclipped, or the PDF is one cut-off page', async () => {
  // <main> is overflow-hidden and its child scroller is overflow-auto. Left
  // alone, a browser prints exactly the visible box and drops the rest.
  const block = printBlock();
  assert.match(block, /overflow:\s*visible\s*!important/);
  assert.match(block, /main\s*\*/, 'the inner scroller must be unclipped too, not just <main>');
  assert.match(block, /padding-left:\s*0\s*!important/, 'the sidebar indent must go');
});

test('animation state cannot leave the page blank', async () => {
  // framer-motion mounts route content at opacity 0 with a translate. Print
  // before the animation settles and you get an empty or offset sheet.
  const block = printBlock();
  assert.match(block, /opacity:\s*1\s*!important/);
  assert.match(block, /transform:\s*none\s*!important/);
  assert.match(block, /animation:\s*none\s*!important/);
});

test('cards do not split across a page break', async () => {
  const block = printBlock();
  assert.match(block, /break-inside:\s*avoid/);
  assert.match(block, /page-break-inside:\s*avoid/, 'the legacy property, for older engines');
});

test('outbound permalinks print their URL', async () => {
  // "View on Instagram" is a dead end on paper without the address.
  const block = printBlock();
  assert.match(block, /a\[href\^="http"\]::after/, 'only outbound links, not in-app hrefs');
  assert.match(block, /content:\s*" \(" attr\(href\) "\)"/);
});

test('the print rules live in globals.css, not a component-imported stylesheet', () => {
  // The delivery mechanism is the whole reason this does not leak: globals.css
  // is imported once by the root layout, so adding a scoped block there costs
  // nothing, while a new component-level import would be global by accident.
  assert.doesNotMatch(COMPONENT, /import\s+['"].*\.css['"]/, 'no stylesheet import in the component');
  assert.match(printBlock(), /@media print/);
});
