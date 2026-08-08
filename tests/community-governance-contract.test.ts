// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('governance defines evidence-based roles, decisions, and transitions', () => {
  const governance = readRepoFile('GOVERNANCE.md');

  for (const heading of [
    'Roles and permissions',
    'Contributor',
    'Triager',
    'Maintainer',
    'Nomination and elevation',
    'Recusal',
    'Inactivity and removal',
    'Founder-led',
    'Maintainer-led',
    'Community-led',
    'Release governance',
  ]) {
    assert.match(governance, new RegExp(heading, 'i'));
  }

  assert.match(governance, /public (issues|pull requests)|GitHub (issues|pull requests)/i);
  assert.match(governance, /measurable|consecutive|within \d+ days/i);
  assert.match(governance, /docs\/RELEASES\.md|release policy is pending/i);
});

test('contributor guide documents the real newcomer and pull-request path', () => {
  const contributing = readRepoFile('CONTRIBUTING.md');

  for (const requirement of [
    /good first issue/i,
    /GitHub Issues/i,
    /fork/i,
    /draft pull request/i,
    /origin\/master|upstream\/master/i,
    /short-lived/i,
    /independent maintainer review/i,
    /full-suite/i,
    /squash/i,
    /no direct pushes|never push directly/i,
    /review feedback|review response/i,
  ]) {
    assert.match(contributing, requirement);
  }

  assert.doesNotMatch(contributing, /Slack community|Discord community/i);
  assert.match(
    contributing,
    /# Collaborator[\s\S]*git fetch origin --prune[\s\S]*git rebase origin\/master[\s\S]*git rev-list --count HEAD\.\.origin\/master/i,
  );
  assert.match(
    contributing,
    /full-suite[\s\S]*complete test inventory[\s\S]*requires-infra[\s\S]*self-skip[\s\S]*feedback-postgres[\s\S]*four selected[\s\S]*PostgreSQL/i,
  );
});

test('published metrics define collection contracts and honest baselines', () => {
  const metrics = readRepoFile('docs/METRICS.md');
  const metricNames = [
    'Contributor growth',
    'Contributor retention',
    'Time to first merged pull request',
    'Adoption',
    'Dependency health',
    'OpenSSF Scorecard',
  ];
  const requiredFields = [
    'Definition / formula',
    'Unit',
    'Data source',
    'Cohort / window',
    'Cadence',
    'Owner',
    'Publication',
    'Baseline',
    'Caveats',
  ];

  for (const metric of metricNames) {
    assert.match(metrics, new RegExp(metric, 'i'));
    const start = metrics.indexOf(`## ${metric}`);
    const next = metrics.indexOf('\n## ', start + 3);
    const section = metrics.slice(start, next === -1 ? undefined : next);

    for (const field of requiredFields) {
      assert.match(
        section,
        new RegExp(field.replace('/', '\\/'), 'i'),
        `${metric} must include ${field}`,
      );
    }
  }

  const inventory = metrics.match(
    /\*\*(\d+) people: (\d+) verified internal \+ (\d+) verified external \+ (\d+) unclassified human contributors \(GAP\)\*\*/i,
  );
  assert.ok(inventory, 'identity inventory must publish one numeric aggregate');
  const [total, internal, external, unclassified] = inventory.slice(1).map(Number);
  assert.equal(total, internal + external + unclassified);
  assert.match(metrics, new RegExp(`\\*\\*Baseline\\*\\* \\|[^\\n]*The ${total}-person identity inventory above`));
  assert.match(metrics, /inventory was recomputed at `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`/i);
  assert.match(metrics, /19 raw signatures[\s\S]*nine known automation signatures[\s\S]*three\s+duplicate human signatures/i);

  const scorecardStart = metrics.indexOf('## OpenSSF Scorecard');
  const scorecardSection = metrics.slice(scorecardStart);
  assert.match(scorecardSection, /2026-08-06T07:53:25-07:00/);
  assert.match(scorecardSection, /github\.com\/DeliciousHouse\/aries-app\/pull\/936/);
  assert.match(scorecardSection, /partial historical observation[\s\S]*GAP/i);

  assert.match(metrics, /bot/i);
  assert.match(metrics, /duplicate identit|mailmap/i);
  assert.match(metrics, /measured values?.*targets?|targets?.*measured values?/is);
  assert.match(metrics, /6\.6\s*\/\s*10/);
  assert.match(metrics, /84f77eacb8ad3e94684af0dda90f829c29927e27/);
  assert.match(metrics, /not (yet )?measured|pending/i);
});

test('community governance contract runs in verify and follows changelog format', () => {
  const verifySuite = readRepoFile('scripts/verify-regression-suite.mjs');
  const changelog = readRepoFile('CHANGELOG.md');
  const version = readRepoFile('VERSION').trim().replaceAll('.', '\\.');

  assert.match(verifySuite, /tests\/community-governance-contract\.test\.ts/);
  const firstVersionHeading = changelog.match(/^## v.+$/m);
  assert.ok(firstVersionHeading, 'changelog must contain a version heading');
  assert.match(firstVersionHeading[0], new RegExp(`^## v${version} — .+$`));
});
