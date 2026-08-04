import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('agent pre-ship guardrail script fetches base branch and surfaces duplicate-work risk', () => {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts/pre-ship-agent-guardrails.mjs');
  assert.equal(existsSync(scriptPath), true, 'expected a reusable pre-ship guardrail script');

  const script = readRepoFile('scripts/pre-ship-agent-guardrails.mjs');
  assert.match(script, /git fetch origin/, 'script should refresh origin before comparing work');
  assert.match(script, /merge-base/, 'script should compare against the latest base branch merge-base');
  assert.match(script, /duplicate/i, 'script should explicitly warn about duplicate or already-landed work');
  assert.match(script, /origin\/\$\{baseBranch\}/, 'script should compare against the detected remote base branch');
});

test('package exposes concurrent test and agent guardrail commands', () => {
  const packageJson = JSON.parse(readRepoFile('package.json')) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};

  assert.equal(scripts['guardrails:agent'], 'node scripts/pre-ship-agent-guardrails.mjs');
  assert.match(scripts['test:concurrent'] ?? '', /--test-concurrency=8/, 'concurrent test script should exercise worker-level parallelism');
  assert.equal(scripts['smoke:scale50'], 'node scripts/smoke-scale-50.mjs');
  assert.match(scripts.verify ?? '', /guardrails:agent/, 'canonical verification should run agent guardrails');
});

test('release metadata stays synchronized across package manifests and VERSION', () => {
  const packageJson = JSON.parse(readRepoFile('package.json')) as { version?: string };
  const packageLock = JSON.parse(readRepoFile('package-lock.json')) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  const version = readRepoFile('VERSION').trim();

  assert.equal(packageJson.version, version, 'package.json should match VERSION');
  assert.equal(packageLock.version, version, 'package-lock.json should match VERSION');
  assert.equal(packageLock.packages?.['']?.version, version, 'package-lock root package should match VERSION');
});

test('Claude guidance promotes lessons into active rules for future agents', () => {
  const claude = readRepoFile('CLAUDE.md');

  assert.match(claude, /Promise\.all[\s\S]*DB_POOL_MAX/, 'guidance should block unbenchmarked DB fan-out');
  assert.match(claude, /git fetch origin[\s\S]*duplicate/i, 'guidance should require a fresh base comparison before shipping');
  assert.match(claude, /Codex[\s\S]*tmux[\s\S]*Use existing model/, 'guidance should document the Codex upgrade-prompt recovery path');
  assert.match(claude, /50[\s\S]*(people|users)/i, 'guidance should include the initial 50-person scale target');
});

test('Aries reviewer pushes its rebased branch before opening a draft PR', () => {
  const reviewer = readRepoFile('.claude/agents/aries-reviewer.md');
  const pushIndex = reviewer.indexOf('git push --force-with-lease');
  const createIndex = reviewer.indexOf('gh pr create');

  assert.notEqual(pushIndex, -1, 'reviewer should preserve rebased work with force-with-lease');
  assert.ok(createIndex > pushIndex, 'reviewer should push the final rebased head before opening the PR');
  assert.match(reviewer, /gh pr create[\s\S]*--draft/, 'reviewer should open the implementation PR as a draft');
});

test('executable Aries orchestration prompts preserve the draft review-lane handoff', () => {
  const promptPaths = [
    '.claude/commands/aries-goal.md',
    '.claude/commands/aries-multibrand-goal.md',
  ];

  for (const promptPath of promptPaths) {
    const prompt = readRepoFile(promptPath);

    assert.match(prompt, /opens? (?:the )?PR as a draft/i, `${promptPath} should require a draft PR`);
    assert.match(
      prompt,
      /even\s+PR(?:\s+number)?[\s\S]{0,120}dev-reviewer[\s\S]{0,120}odd\s+PR(?:\s+number)?[\s\S]{0,120}dev-reviewer-2/i,
      `${promptPath} should route the PR to the deterministic review lane`,
    );
    assert.match(
      prompt,
      /never (?:merges?|merge)[^\n]*enable(?:s)? auto-merge/i,
      `${promptPath} should forbid reviewer-side merge and auto-merge`,
    );
    assert.doesNotMatch(prompt, /ready, not draft/i, `${promptPath} must not require a ready PR`);
    assert.doesNotMatch(prompt, /gh pr merge/i, `${promptPath} must not direct an agent to merge the PR`);
    assert.doesNotMatch(
      prompt,
      /auto-merge on green CI is the policy/i,
      `${promptPath} must not make auto-merge the orchestration policy`,
    );
  }
});

test('database health route singleflights 50-person smoke checks', () => {
  const healthRoute = readRepoFile('app/api/health/db/route.ts');

  assert.match(healthRoute, /HEALTH_CACHE_TTL_MS\s*=\s*1_000/, 'health route should use a short TTL to absorb bursts');
  assert.match(healthRoute, /inFlightProbe/, 'health route should share one in-flight DB probe across concurrent requests');
  assert.match(healthRoute, /cachedProbe/, 'health route should cache a recent successful DB probe');
  assert.match(healthRoute, /cacheAgeMs/, 'health response should expose cache age for diagnostics');
});

test('Docker docs include a 50-person starting profile and full-endpoint load check', () => {
  const dockerDocs = readRepoFile('DOCKER.md');

  assert.match(dockerDocs, /50[\s\S]*(people|users)/i, 'Docker docs should name the launch-scale target');
  assert.match(dockerDocs, /ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10/, 'Docker docs should keep a safe initial worker/pool profile');
  assert.match(dockerDocs, /seq 1 50[\s\S]*-P50/, 'Docker docs should include a 50-concurrent smoke check');
  assert.match(dockerDocs, /npm run smoke:scale50/, 'Docker docs should include the reusable 50-user smoke command');
  assert.match(dockerDocs, /api\/health\/db/, 'Docker docs should keep database readiness in the scale check');
});
