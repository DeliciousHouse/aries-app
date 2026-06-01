#!/usr/bin/env node
// ---------------------------------------------------------------------------
// list-requires-infra.mjs — make the "requires-infra vs self-contained" test
// split legible (public-readiness roadmap area 1a).
//
//   node scripts/list-requires-infra.mjs          # print the split (informational, default)
//   node scripts/list-requires-infra.mjs --run     # run ONLY the requires-infra files,
//                                                   # gated behind ARIES_TEST_REQUIRES_INFRA_ENABLED
//
// A test file is "requires-infra" iff it calls `requireDbEnvOrSkip(` (the shared guard in
// tests/helpers/requires-infra.ts). Those files self-skip with 'database env not configured'
// when DB_* env is absent, so the `full-suite` CI gate never runs them. This script counts
// them, and (with --run + the flag + a reachable DB) runs them for real locally.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const GUARD_MARKER = 'requireDbEnvOrSkip(';

/** Recursively collect every *.test.ts under tests/. */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

function classify() {
  const requiresInfra = [];
  const selfContained = [];
  for (const file of collectTestFiles(TESTS_DIR)) {
    const src = readFileSync(file, 'utf8');
    // Count guard call sites (a test file is requires-infra if it has at least one),
    // but ignore the helper definition itself.
    const rel = path.relative(REPO_ROOT, file);
    if (rel === path.join('tests', 'helpers', 'requires-infra.ts')) continue;
    if (src.includes(GUARD_MARKER)) requiresInfra.push(rel);
    else selfContained.push(rel);
  }
  return { requiresInfra, selfContained };
}

function flagEnabled() {
  const v = String(process.env.ARIES_TEST_REQUIRES_INFRA_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function hasDbEnv() {
  return ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].every(
    (k) => typeof process.env[k] === 'string' && process.env[k].trim() !== '',
  );
}

function printReport({ requiresInfra, selfContained }) {
  console.log('Test split (public-readiness area 1a):');
  console.log(`  self-contained : ${selfContained.length} files (mock pool.query / mkdtemp DATA_ROOT / no socket)`);
  console.log(`  requires-infra : ${requiresInfra.length} files (need a reachable Postgres via requireDbEnvOrSkip)`);
  console.log('');
  console.log('Requires-infra files:');
  for (const f of requiresInfra) console.log(`  - ${f}`);
  console.log('');
  console.log('See tests/REQUIRES_INFRA.md for the env each needs and how to run them.');
}

const runMode = process.argv.includes('--run');
const split = classify();

if (!runMode) {
  printReport(split);
  process.exit(0);
}

// --run path: execute only the requires-infra files, gated behind the flag.
if (!flagEnabled()) {
  console.log('ARIES_TEST_REQUIRES_INFRA_ENABLED is not set — requires-infra suite is informational only.');
  printReport(split);
  console.log('\nTo run them: set ARIES_TEST_REQUIRES_INFRA_ENABLED=1 and DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME, then `npm run test:requires-infra`.');
  process.exit(0);
}

if (!hasDbEnv()) {
  console.error('ARIES_TEST_REQUIRES_INFRA_ENABLED is on but DB_* env is incomplete.');
  console.error('Set DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME to a reachable Postgres and retry.');
  process.exit(1);
}

if (split.requiresInfra.length === 0) {
  console.log('No requires-infra test files found.');
  process.exit(0);
}

console.log(`Running ${split.requiresInfra.length} requires-infra files against the live DB...`);
const result = spawnSync(
  'npx',
  ['--no-install', 'tsx', '--test', '--test-concurrency=1', ...split.requiresInfra],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, APP_BASE_URL: process.env.APP_BASE_URL || 'https://aries.example.com' },
  },
);
process.exit(result.status ?? 1);
