import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
type PathSpec = { path: string; auth: boolean };
type Summary = { path: string; p95Ms: number };
type BaselineDoc = { concurrency?: number; paths: Array<{ path: string; p95Ms: number }> };

/**
 * The harness is a plain .mjs script with no type declarations (it has to run
 * under bare `node` on a deploy host, with no build step). Import it once and
 * describe the pure helpers explicitly, rather than scattering ts-ignores.
 */
// @ts-expect-error -- untyped .mjs module, shaped below.
import * as harnessModule from '../scripts/smoke-scale-50.mjs';

const {
  AUTHED_PATHS,
  PUBLIC_PATHS,
  compareToBaseline,
  evaluateStatus,
  loadCookieHeader,
  parsePathSpec,
  percentile,
  positiveInteger,
  resolvePaths,
  smokePath,
} = harnessModule as unknown as {
  AUTHED_PATHS: readonly string[];
  PUBLIC_PATHS: readonly string[];
  compareToBaseline: (
    summaries: Summary[],
    baseline: BaselineDoc,
    opts?: { tolerancePct?: number; floorMs?: number; concurrency?: number },
  ) => {
    regressions: Array<{ path: string; baselineP95Ms: number; currentP95Ms: number }>;
    missing: string[];
    concurrencyMismatch: { baseline: number; current: number } | null;
  };
  evaluateStatus: (status: number, expected: number) => { ok: boolean; reason?: string };
  loadCookieHeader: (file?: string, read?: (p: string, enc: string) => string) => string | null;
  parsePathSpec: (item: string, defaultAuth?: boolean) => PathSpec;
  percentile: (values: number[], pct: number) => number;
  positiveInteger: (value: unknown, fallback: number) => number;
  resolvePaths: (env?: Record<string, string | undefined>) => PathSpec[];
  smokePath: (
    baseUrl: string,
    spec: PathSpec,
    concurrency: number,
    opts?: { cookieHeader?: string | null; expectedStatus?: number; fetchImpl?: unknown },
  ) => Promise<{ failures: number; firstError: string | null }>;
};

/**
 * S7-1 / AA-119 (gap D6) — the authenticated 50-user smoke harness.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/smoke-scale-harness.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// ── The false-pass this card exists to close ─────────────────────────────────

test('a redirect FAILS — it is how an unauthenticated run used to look healthy', () => {
  // The old harness accepted anything under 500, so /insights answering 307 to
  // /login counted as a pass.
  for (const status of [301, 302, 303, 307, 308]) {
    const verdict = evaluateStatus(status, 200);
    assert.equal(verdict.ok, false, `${status} must fail`);
    assert.match(verdict.reason!, /redirect/, `${status} should name the cause`);
  }
});

test('only the expected status passes — not "anything under 500"', () => {
  assert.equal(evaluateStatus(200, 200).ok, true);
  for (const status of [201, 204, 400, 401, 403, 404, 429, 499]) {
    assert.equal(evaluateStatus(status, 200).ok, false, `${status} must not pass`);
  }
  // A 5xx obviously fails too.
  assert.equal(evaluateStatus(500, 200).ok, false);
  // An endpoint whose contract really is 204 can say so.
  assert.equal(evaluateStatus(204, 204).ok, true);
});

test('the harness does NOT follow redirects', async () => {
  // Load-bearing, and invisible to status checking alone: fetch follows
  // redirects by default, so /insights -> /login would resolve to the LOGIN
  // page's own 200 and pass every other assertion in this file.
  let sawRedirectOption: string | undefined;
  const fetchImpl = async (_url: string, init: { redirect?: string }) => {
    sawRedirectOption = init?.redirect;
    return { status: 307, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
  };

  const summary = await smokePath(
    'http://localhost:3000',
    { path: '/insights', auth: true },
    2,
    { cookieHeader: 'authjs.session-token=x', fetchImpl },
  );

  assert.equal(sawRedirectOption, 'manual', 'redirect:manual must be set');
  assert.equal(summary.failures, 2, 'a 307 must be counted as a failure, not followed');
  assert.match(String(summary.firstError), /redirect/);
});

test('a source-level pin: redirect:manual cannot be dropped silently', () => {
  const source = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'smoke-scale-50.mjs'), 'utf8');
  assert.match(source, /redirect: 'manual'/);
  // And the old permissive rule must not come back.
  assert.doesNotMatch(source, /status >= 200 && response\.status < 500/);
});

// ── Auth wiring ──────────────────────────────────────────────────────────────

test('the cookie file from mint-qa-session becomes a Cookie header', () => {
  const playwrightFormat = JSON.stringify([
    { name: 'authjs.session-token', value: 'abc123', domain: 'localhost', path: '/' },
  ]);
  assert.equal(
    loadCookieHeader('/tmp/c.json', () => playwrightFormat),
    'authjs.session-token=abc123',
  );

  // Multiple cookies join; malformed entries are dropped rather than rendered
  // as "undefined=undefined".
  const multi = JSON.stringify([
    { name: 'a', value: '1' },
    { nope: true },
    { name: 'b', value: '2' },
  ]);
  assert.equal(loadCookieHeader('/tmp/c.json', () => multi), 'a=1; b=2');

  assert.equal(loadCookieHeader(undefined), null);
  assert.equal(loadCookieHeader('  '), null);
});

test('the cookie is sent ONLY to paths that declare they need it', async () => {
  const seen: Array<string | undefined> = [];
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers.cookie);
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
  };
  const opts = { cookieHeader: 'authjs.session-token=x', fetchImpl };

  await smokePath('http://localhost:3000', { path: '/insights', auth: true }, 1, opts);
  await smokePath('http://localhost:3000', { path: '/api/health/db', auth: false }, 1, opts);

  assert.equal(seen[0], 'authjs.session-token=x', 'gated path gets the session');
  assert.equal(seen[1], undefined, 'a public path is measured unauthenticated');
});

test('an auth-required run with no cookie is a hard error, not a silent skip', () => {
  // Pinned at the source: measuring a gated path unauthenticated is exactly the
  // meaningless pass this card removes.
  const source = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'smoke-scale-50.mjs'), 'utf8');
  assert.match(source, /needsAuth && !cookieHeader/);
  assert.match(source, /mint-qa-session\.ts/, 'the error must tell you how to fix it');
});

// ── Path resolution ──────────────────────────────────────────────────────────

test('default behaviour is unchanged — public paths only', () => {
  assert.deepEqual(
    resolvePaths({}).map((p: PathSpec) => p.path),
    PUBLIC_PATHS,
  );
  assert.ok(resolvePaths({}).every((p: PathSpec) => p.auth === false));
});

test('SCALE_SMOKE_AUTHED adds the /insights profile, all marked auth', () => {
  const paths = resolvePaths({ SCALE_SMOKE_AUTHED: '1' });
  assert.deepEqual(paths.slice(0, 2).map((p: PathSpec) => p.path), PUBLIC_PATHS);
  const authed = paths.filter((p: PathSpec) => p.auth);
  assert.deepEqual(authed.map((p: PathSpec) => p.path), [...AUTHED_PATHS]);
  assert.ok(authed.length >= 10, 'the page plus its section endpoints');
});

test('the authed profile covers the page AND the endpoints it fans out to', () => {
  // A page-only smoke would miss the pool pressure, which is the whole point of
  // a 50-user profile: one page open is ~10 concurrent section queries.
  assert.ok(AUTHED_PATHS.includes('/insights'));
  for (const section of ['narrative', 'goal', 'attention', 'activity', 'trends', 'top']) {
    assert.ok(
      AUTHED_PATHS.some((p: string) => p.startsWith(`/api/insights/${section}`)),
      `missing section endpoint: ${section}`,
    );
  }
});

test('explicit SCALE_SMOKE_PATHS wins, with ! marking auth-required', () => {
  const paths = resolvePaths({ SCALE_SMOKE_PATHS: '/, !/insights, api/health/db' });
  assert.deepEqual(paths, [
    { path: '/', auth: false },
    { path: '/insights', auth: true },
    { path: '/api/health/db', auth: false },
  ]);
});

test('parsePathSpec normalizes a leading slash', () => {
  assert.deepEqual(parsePathSpec('insights'), { path: '/insights', auth: false });
  assert.deepEqual(parsePathSpec('!insights'), { path: '/insights', auth: true });
});

// ── Numbers ──────────────────────────────────────────────────────────────────

test('positiveInteger rejects exponent notation and junk', () => {
  assert.equal(positiveInteger('50', 10), 50);
  // Number('1e2') is 100 — accepting it would silently run a concurrency
  // nobody typed (the parsePoolMax trap).
  for (const bad of ['1e2', '0', '-5', '2.5', 'fifty', '', undefined, null]) {
    assert.equal(positiveInteger(bad, 10), 10, String(bad));
  }
});

test('percentile is stable at the edges', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 100), 10);
});

// ── Baseline ─────────────────────────────────────────────────────────────────

const BASELINE = {
  paths: [
    { path: '/insights', p95Ms: 400 },
    { path: '/api/insights/goal?period=week', p95Ms: 200 },
  ],
};

test('a run within tolerance passes', () => {
  const { regressions } = compareToBaseline(
    [
      { path: '/insights', p95Ms: 440 },
      { path: '/api/insights/goal?period=week', p95Ms: 210 },
    ],
    BASELINE,
  );
  assert.deepEqual(regressions, []);
});

test('a real regression fails and reports the numbers', () => {
  const { regressions } = compareToBaseline([{ path: '/insights', p95Ms: 900 }], BASELINE, {
    tolerancePct: 25,
  });
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].path, '/insights');
  assert.equal(regressions[0].baselineP95Ms, 400);
  assert.equal(regressions[0].currentP95Ms, 900);
});

test('an absolute floor stops a fast endpoint tripping on jitter', () => {
  // 30ms -> 40ms is +33%, over the percentage tolerance, but meaningless.
  const { regressions } = compareToBaseline([{ path: '/fast', p95Ms: 40 }], {
    paths: [{ path: '/fast', p95Ms: 30 }],
  });
  assert.deepEqual(regressions, [], 'small absolute deltas must not fail the run');

  // The case that actually bit on the first live run: a 93ms endpoint measured
  // at 146ms on an UNCHANGED system. p95 over a few dozen samples moves that
  // much, and a gate that fails when nothing changed gets switched off.
  const unchanged = compareToBaseline([{ path: '/api/insights/top', p95Ms: 146 }], {
    paths: [{ path: '/api/insights/top', p95Ms: 93 }],
  });
  assert.deepEqual(unchanged.regressions, [], 'jitter on a ~100ms path must not fail');

  // A genuine doubling still fails.
  const real = compareToBaseline([{ path: '/api/insights/top', p95Ms: 400 }], {
    paths: [{ path: '/api/insights/top', p95Ms: 93 }],
  });
  assert.equal(real.regressions.length, 1);
});

test('a baseline captured at a different concurrency is refused, not compared', () => {
  // Latency scales with load, so comparing a concurrency-8 baseline against a
  // concurrency-4 run reports a difference that has nothing to do with the
  // change under test. Observed live: section endpoints "improved" purely
  // because the run was half the load.
  const { concurrencyMismatch } = compareToBaseline(
    [{ path: '/insights', p95Ms: 100 }],
    { concurrency: 8, paths: [{ path: '/insights', p95Ms: 100 }] },
    { concurrency: 4 },
  );
  assert.deepEqual(concurrencyMismatch, { baseline: 8, current: 4 });

  const matched = compareToBaseline(
    [{ path: '/insights', p95Ms: 100 }],
    { concurrency: 8, paths: [{ path: '/insights', p95Ms: 100 }] },
    { concurrency: 8 },
  );
  assert.equal(matched.concurrencyMismatch, null);
});

test('a path missing from the baseline is REPORTED, not silently passed', () => {
  // Otherwise adding a path quietly opts it out of every future comparison.
  const { regressions, missing } = compareToBaseline([{ path: '/brand-new', p95Ms: 5000 }], BASELINE);
  assert.deepEqual(regressions, []);
  assert.deepEqual(missing, ['/brand-new']);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('DOCKER.md documents the authenticated profile, not just the old command', () => {
  const doc = readFileSync(path.join(PROJECT_ROOT, 'DOCKER.md'), 'utf8');
  assert.match(doc, /mint-qa-session\.ts/, 'the profile check must show how to authenticate');
  assert.match(doc, /SCALE_SMOKE_AUTHED/);
  assert.match(doc, /SCALE_SMOKE_COOKIE_FILE/);
  assert.match(doc, /--baseline-out|SCALE_SMOKE_BASELINE_OUT/, 'baseline capture must be documented');
});
