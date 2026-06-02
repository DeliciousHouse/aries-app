import type { TestContext } from 'node:test';

/**
 * Shared "requires-infra" guard for the live-Postgres test files.
 *
 * Public-readiness roadmap area 1(a) asks for a *clear* split between self-contained
 * tests (mock `pool.query`, write fixtures under a per-test `mkdtemp` DATA_ROOT, open no
 * socket) and requires-infra tests (need a reachable Postgres). This helper is the single,
 * greppable source of truth for that split: a test file is "requires-infra" iff it calls
 * `requireDbEnvOrSkip(t)`. `scripts/list-requires-infra.mjs` counts those call sites and
 * `tests/REQUIRES_INFRA.md` indexes them.
 *
 * It checks the SUPERSET of DB env keys every live-DB test reads today —
 * `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (audited 2026-06-01 across all
 * seven files; every one gates on exactly these five). Requiring the full set — never a
 * laxer subset — guarantees a file that should skip on a partial-env runner is never made
 * to suddenly *run* (and fail). When any key is missing it marks the test skipped with the
 * canonical string `'database env not configured'` (unchanged, so the `full-suite` CI gate's
 * output and skip counts are identical) and returns `false`; otherwise returns `true`.
 */
export const REQUIRES_INFRA_DB_ENV_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
] as const;

/** True only when every required DB env key is present and non-blank. */
export function hasRequiredDbEnv(): boolean {
  return REQUIRES_INFRA_DB_ENV_KEYS.every((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * Returns `true` when the live-DB env is present (the test should run). Otherwise skips the
 * test with the canonical `'database env not configured'` string and returns `false`.
 * Idiomatic use: `if (!requireDbEnvOrSkip(t)) return;`
 */
export function requireDbEnvOrSkip(t: TestContext): boolean {
  if (hasRequiredDbEnv()) return true;
  t.skip('database env not configured');
  return false;
}
