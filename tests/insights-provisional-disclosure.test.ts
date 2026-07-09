/**
 * tests/insights-provisional-disclosure.test.ts
 *
 * S1-9 / AA-88 — interim inflated-totals disclosure (Gap A1 mitigation). Source
 * scan (these are client components, so a source scan is the right surface):
 *  - the shared ProvisionalMetricNote exists and carries the REMOVE IN S2-1
 *    marker + the greppable removal token, so S2-1 can find and rip it out;
 *  - both /insights sections that render raw per-post-summed totals (Top,
 *    Goal) render the note;
 *  - the legacy /dashboard/analytics screen carries the disclosure too (the bug
 *    inflates BOTH surfaces; S2-1 acceptance requires both to agree post-fix);
 *  - the grep token appears in >=3 sites so the S2-1 removal sweep finds them all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOKEN = 'S1-9-PROVISIONAL-DISCLOSURE';
const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('ProvisionalMetricNote exists and is tagged for S2-1 removal', () => {
  const src = read('../frontend/insights/ProvisionalMetricNote.tsx');
  assert.match(src, /export function ProvisionalMetricNote/);
  assert.match(src, /REMOVE IN S2-1/, 'must carry the S2-1 removal marker');
  assert.match(src, new RegExp(TOKEN), 'must carry the greppable removal token');
});

test('/insights Top + Goal sections render the provisional note', () => {
  for (const file of ['../frontend/insights/TopPostsSection.tsx', '../frontend/insights/GoalSection.tsx']) {
    const src = read(file);
    assert.match(src, /<ProvisionalMetricNote/, `${file} must render the disclosure`);
  }
});

test('legacy /dashboard/analytics screen carries the disclosure', () => {
  const src = read('../frontend/aries-v1/analytics-screen.tsx');
  assert.match(src, new RegExp(TOKEN), 'legacy analytics screen must carry the removal token');
  assert.match(src, /Provisional totals/, 'legacy screen must show a provisional disclaimer');
});

test('the removal token appears in >=3 sites so S2-1 can sweep them all', () => {
  const files = [
    '../frontend/insights/ProvisionalMetricNote.tsx',
    '../frontend/insights/TopPostsSection.tsx',
    '../frontend/insights/GoalSection.tsx',
    '../frontend/aries-v1/analytics-screen.tsx',
  ];
  const sites = files.filter((f) => read(f).includes(TOKEN));
  assert.ok(sites.length >= 3, `expected the token in >=3 sites, found ${sites.length}: ${sites.join(', ')}`);
});
