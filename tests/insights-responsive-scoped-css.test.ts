/**
 * tests/insights-responsive-scoped-css.test.ts
 *
 * S8-5 / AA-128 — the insights.css global leak, and the missing breakpoints.
 *
 * HONEST LIMIT: no test runner here evaluates a media query or a cascade, so
 * this file cannot prove the page reflows or that the leak is gone. It pins the
 * two things that ARE checkable — every selector in the stylesheet is scoped,
 * and every section grid routes through a class that has a breakpoint — which
 * is the drift guard, not the proof.
 *
 * The proof came from real Chrome (computed styles, three viewport widths, with
 * an unrelated route rendered alongside the dashboard): 11/11 with this
 * stylesheet, and 2/11 with the pre-fix one — where the unrelated route's body
 * really did turn rgb(14,14,18) and Inter, which is the leak the ticket
 * describes, reproduced.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-responsive-scoped-css.test.ts
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const INSIGHTS_DIR = path.join(PROJECT_ROOT, 'frontend', 'insights');
const CSS = readFileSync(path.join(INSIGHTS_DIR, 'insights.css'), 'utf8');
const DASHBOARD = readFileSync(path.join(INSIGHTS_DIR, 'InsightsDashboard.tsx'), 'utf8');

/** Selector text of every rule, with comments and at-rule wrappers removed. */
function selectors(): string[] {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')       // comments
    .split('}')
    .map((block) => block.split('{')[0].trim())
    .filter(Boolean)
    .flatMap((sel) => sel.split(',').map((s) => s.trim()))
    .filter((sel) => sel && !sel.startsWith('@') && !/^\d+%$/.test(sel) && sel !== 'from' && sel !== 'to');
}

// ── The leak ─────────────────────────────────────────────────────────────────

test('no selector escapes the dashboard scope', () => {
  // This file is imported by a client component, so Next bundles it app-wide
  // and it is never unloaded. An unscoped selector here does not style "the
  // insights page" — it styles every route, permanently, from the first visit.
  const ALLOWED_UNSCOPED = new Set([
    '.insights-surface',
    '.insights-dashboard-content', // only ever rendered inside the surface
    '.insights-grid',
    '.insights-grid-3',
  ]);

  const escaped = selectors().filter(
    (sel) => !sel.includes('.insights-') || !(sel.startsWith('.insights-') || ALLOWED_UNSCOPED.has(sel)),
  );
  assert.deepEqual(escaped, [], `every rule must be scoped; escaped: ${escaped.join(' | ')}`);
});

test('the body element is never restyled', () => {
  // The specific regression: `body { background; color; font-family }` repainted
  // the canvas and typeface of the whole product after one visit to /insights.
  assert.doesNotMatch(CSS, /(^|\n)\s*body\s*[,{]/, 'no bare body rule');
  assert.doesNotMatch(CSS, /(^|\n)\s*html\s*[,{]/, 'and no bare html rule');
});

test('scrollbars and focus rings are scoped, not global', () => {
  // Both were app-wide overrides — the focus ring in particular forced this
  // page's accent colour onto routes with a different one.
  for (const fragment of ['::-webkit-scrollbar', ':focus-visible']) {
    const rules = selectors().filter((sel) => sel.includes(fragment));
    assert.ok(rules.length > 0, `expected ${fragment} rules to still exist`);
    for (const rule of rules) {
      assert.ok(
        rule.startsWith('.insights-surface'),
        `${fragment} must be scoped, found: ${rule}`,
      );
    }
  }
});

test('the universal reset is scoped and still never zeroes shell padding', () => {
  // AA-145's guarantee, carried forward: route CSS must not collapse the
  // AppShell padding that clears the fixed nav rail. Scoping makes that
  // guarantee stronger — the rule can no longer reach the shell at all.
  const universal = CSS.match(
    /\.insights-surface \*,\s*\n\.insights-surface \*::before,\s*\n\.insights-surface \*::after\s*\{(?<decl>[\s\S]*?)\}/,
  );
  assert.ok(universal?.groups?.decl, 'the box-sizing reset must exist, scoped');
  assert.match(universal.groups.decl, /box-sizing:\s*border-box/);
  assert.doesNotMatch(universal.groups.decl, /\b(?:margin|padding)\s*:/);
});

test('the dashboard root carries the scope, or the stylesheet applies to nothing', () => {
  assert.match(DASHBOARD, /className="insights-surface"/);
});

test('the duplicated reduced-motion block is gone, and globals still has one', () => {
  // It was byte-identical to the block in globals.css, which is also more
  // complete (it resets scroll-behavior too). Deleting the copy loses nothing;
  // this asserts the survivor is really there rather than trusting that.
  assert.doesNotMatch(CSS, /prefers-reduced-motion/, 'the duplicate is removed');
  const globals = readFileSync(path.join(PROJECT_ROOT, 'app', 'globals.css'), 'utf8');
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/, 'globals.css still covers it');
  assert.match(globals, /animation-duration:\s*0\.01ms\s*!important/);
});

// ── The breakpoints ──────────────────────────────────────────────────────────

test('the grid classes carry a breakpoint', () => {
  assert.match(CSS, /\.insights-grid\s*\{[^}]*grid-template-columns:\s*var\(--insights-cols/);
  assert.match(
    CSS,
    /@media \(max-width: 900px\)\s*\{\s*\.insights-grid\s*\{\s*grid-template-columns:\s*1fr/,
    'two-column grids must collapse',
  );
  assert.match(
    CSS,
    /@media \(max-width: 900px\)\s*\{\s*\.insights-grid-3\s*\{\s*grid-template-columns:\s*repeat\(2/,
    'the three-across grid steps down before it collapses',
  );
  assert.match(
    CSS,
    /@media \(max-width: 640px\)\s*\{\s*\.insights-grid-3\s*\{\s*grid-template-columns:\s*1fr/,
  );
});

test('no section sets a fixed column count inline, where a media query cannot reach', () => {
  // The root cause. An inline gridTemplateColumns cannot carry a breakpoint, so
  // a section that sets one is fixed at every viewport by construction.
  const offenders: string[] = [];
  for (const file of readdirSync(INSIGHTS_DIR).filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(path.join(INSIGHTS_DIR, file), 'utf8');
    for (const match of source.matchAll(/gridTemplateColumns:\s*"([^"]+)"/g)) {
      // `auto-fit`/`auto-fill` reflow on their own without a media query, so
      // they are the one inline form that is legitimately responsive.
      if (!/auto-fit|auto-fill/.test(match[1])) offenders.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `fixed inline grids remain: ${offenders.join(' | ')}`);
});

test('every converted section passes its own ratio through the custom property', () => {
  // The ratio belongs to the section; only the breakpoint is shared. If a
  // section forgot the property it would silently fall back to the 1fr 1fr
  // default and quietly lose its intended proportions on desktop.
  const usages: string[] = [];
  for (const file of readdirSync(INSIGHTS_DIR).filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(path.join(INSIGHTS_DIR, file), 'utf8');
    const gridUses = (source.match(/className="insights-grid"/g) ?? []).length;
    const varUses = (source.match(/"--insights-cols":/g) ?? []).length;
    if (gridUses > 0) {
      assert.equal(varUses, gridUses, `${file}: ${gridUses} .insights-grid uses but ${varUses} ratios`);
      usages.push(file);
    }
  }
  assert.ok(usages.length >= 7, `expected the section grids to be converted, saw ${usages.length}`);
});
