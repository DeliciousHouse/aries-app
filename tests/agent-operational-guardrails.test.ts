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

test('Claude guidance promotes lessons into active rules for future agents', () => {
  const claude = readRepoFile('CLAUDE.md');

  assert.match(claude, /Promise\.all[\s\S]*DB_POOL_MAX/, 'guidance should block unbenchmarked DB fan-out');
  assert.match(claude, /git fetch origin[\s\S]*duplicate/i, 'guidance should require a fresh base comparison before shipping');
  assert.match(claude, /Codex[\s\S]*tmux[\s\S]*Use existing model/, 'guidance should document the Codex upgrade-prompt recovery path');
  assert.match(claude, /50[\s\S]*(people|users)/i, 'guidance should include the initial 50-person scale target');
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
