// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

test('governance defines accountable roles and measurable transitions without a legal-owner claim', () => {
  const doc = read('GOVERNANCE.md');
  for (const heading of ['Roles and rights', 'Nomination and elevation', 'Recusal', 'Inactivity and removal', 'Decision authority', 'Transition stages']) {
    assert.ok(doc.includes(`## ${heading}`), heading);
  }
  for (const stage of ['Founder-led', 'Maintainer-led', 'Community-led']) assert.ok(doc.includes(stage));
  assert.doesNotMatch(doc, /maintained by Sugar & Leather|community-led today/i);
});

test('contribution policy distinguishes review policy from GitHub enforcement', () => {
  const doc = read('CONTRIBUTING.md');
  for (const text of ['good first issue', 'fork', 'draft', 'git merge origin/master', 'npm run verify', 'full-suite', 'independent', 'squash', 'zero formal approvals', 'GitHub Issues', 'Release cadence and versioning']) {
    assert.ok(doc.includes(text), text);
  }
  assert.match(doc, /Node\.js 24/);
  assert.doesNotMatch(doc, /npm run test\n/);
});

test('every metric records a reproducible definition and honest baseline', () => {
  const doc = read('docs/METRICS.md');
  const sections = doc.split(/^## /m).slice(1).filter(section => /^\d\. /.test(section));
  assert.equal(sections.length, 6);
  for (const section of sections) {
    for (const field of ['Formula:', 'Unit:', 'Source:', 'Cohort/window:', 'Cadence:', 'Owner:', 'Publication:', 'Baseline (2026-10-03):', 'Caveats:']) {
      assert.ok(section.includes(field), `${section.split('\n')[0]}: ${field}`);
    }
  }
  for (const text of ['bots', 'gap', 'targets', 'unclassified', '--paginate', 'unmerged', 'censored']) assert.ok(doc.toLowerCase().includes(text), text);
});
