#!/usr/bin/env node
/**
 * S7-1 / AA-119 (gap D6) — authenticated 50-user smoke harness.
 *
 * WHAT CHANGED AND WHY. This harness previously hit only `/` and
 * `/api/health/db`, could not authenticate, and accepted any status < 500. Those
 * three facts compose into a trap: appending `/insights` to the old harness
 * would have PASSED against an unauthenticated server, because the gated page
 * answers with a redirect to /login and a redirect is neither an error nor a
 * 5xx. The harness would have reported a healthy 50-user insights profile while
 * measuring nothing but the login page.
 *
 * Three defences, all required — any one alone still false-passes:
 *
 *   1. `redirect: 'manual'`. This is the load-bearing one. `fetch` follows
 *      redirects by default, so /insights -> /login resolves to the LOGIN
 *      page's own 200. Strict status checking alone would not catch it; the
 *      harness has to see the 307.
 *   2. Strict expected status (200 by default), not "anything under 500".
 *   3. An explicit auth requirement per path: a path marked `auth` with no
 *      session cookie is a HARD ERROR, never a silent skip or an unauthenticated
 *      measurement.
 *
 * Baseline: `--baseline-out` writes the measured profile; `--baseline` compares
 * against one and fails on regression beyond a tolerance. S7-1 captures the
 * pre-optimization baseline that S7-2..S7-5 are each re-run against.
 *
 * Session: mint with scripts/qa/mint-qa-session.ts and pass the cookie file via
 * SCALE_SMOKE_COOKIE_FILE. The QA sandbox identity is pinned by that tool.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';

/** Unauthenticated liveness paths — the original harness's scope. */
export const PUBLIC_PATHS = ['/', '/api/health/db'];

/**
 * The authenticated /insights profile: the page plus every section endpoint it
 * fans out to on load. These are what a real operator's page-open actually
 * costs, and what a 50-user profile has to survive.
 */
export const AUTHED_PATHS = [
  '/insights',
  '/api/insights/freshness',
  '/api/insights/narrative?period=week',
  '/api/insights/goal?period=week',
  '/api/insights/attention?period=week',
  '/api/insights/activity?period=week',
  '/api/insights/trends?period=week',
  '/api/insights/top?period=week&sort=reach',
  '/api/insights/conversations?period=week',
  '/api/insights/aries?period=week',
  '/api/insights/audience?period=week',
];

export function positiveInteger(value, fallback) {
  const raw = String(value ?? '').trim();
  // Require a plain integer: Number('1e2') is 100, which would silently accept
  // exponent notation for a concurrency/budget nobody typed.
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Normalize one path spec into `{ path, auth }`. A `!` prefix marks auth-required. */
export function parsePathSpec(item, defaultAuth = false) {
  let raw = String(item).trim();
  let auth = defaultAuth;
  if (raw.startsWith('!')) {
    auth = true;
    raw = raw.slice(1);
  }
  if (!raw.startsWith('/')) raw = `/${raw}`;
  return { path: raw, auth };
}

/**
 * Resolve the path set.
 *   SCALE_SMOKE_PATHS      — explicit override (prefix `!` to require auth)
 *   SCALE_SMOKE_AUTHED=1   — public + the authenticated /insights profile
 *   (neither)              — public only, i.e. the original behaviour
 */
export function resolvePaths(env = process.env) {
  const raw = env.SCALE_SMOKE_PATHS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => parsePathSpec(item));
  }
  const authed = /^(1|true|yes|on)$/i.test(env.SCALE_SMOKE_AUTHED?.trim() ?? '');
  const paths = PUBLIC_PATHS.map((p) => parsePathSpec(p, false));
  if (authed) paths.push(...AUTHED_PATHS.map((p) => parsePathSpec(p, true)));
  return paths;
}

/**
 * Read the cookie file produced by scripts/qa/mint-qa-session.ts and render a
 * Cookie header. Returns null when no file is configured.
 */
export function loadCookieHeader(filePath, readFile = readFileSync) {
  const target = filePath?.trim();
  if (!target) return null;
  const parsed = JSON.parse(readFile(target, 'utf8'));
  const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies ? parsed.cookies : [parsed];
  const rendered = cookies
    .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return rendered || null;
}

export function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index];
}

/**
 * Is this response acceptable?
 *
 * A redirect is NEVER acceptable. On a gated path it means the session was not
 * accepted, and following it would have measured the login page — the precise
 * false-pass this harness exists to prevent.
 */
export function evaluateStatus(status, expectedStatus) {
  if (status === expectedStatus) return { ok: true };
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      reason: `redirect (${status}) — not authenticated, or the path is gated`,
    };
  }
  return { ok: false, reason: `expected ${expectedStatus}, got ${status}` };
}

async function requestOnce(url, { cookieHeader, expectedStatus, fetchImpl = fetch }) {
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, {
      // Load-bearing: see the header note. Following a redirect would turn a
      // failed auth into the login page's 200.
      redirect: 'manual',
      headers: {
        'user-agent': 'aries-scale-smoke/2.0',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    });
    await response.arrayBuffer().catch(() => undefined);
    const verdict = evaluateStatus(response.status, expectedStatus);
    return {
      ok: verdict.ok,
      status: response.status,
      ms: performance.now() - startedAt,
      error: verdict.ok ? undefined : verdict.reason,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function smokePath(baseUrl, spec, concurrency, opts = {}) {
  const url = new URL(spec.path, baseUrl).toString();
  const expectedStatus = opts.expectedStatus ?? 200;
  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      requestOnce(url, {
        cookieHeader: spec.auth ? opts.cookieHeader : null,
        expectedStatus,
        fetchImpl: opts.fetchImpl,
      }),
    ),
  );
  const failures = results.filter((r) => !r.ok);
  const latencies = results.map((r) => r.ms);
  return {
    path: spec.path,
    auth: spec.auth,
    url,
    requests: results.length,
    failures: failures.length,
    statuses: results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {}),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: Math.max(...latencies),
    firstError: failures.find((f) => f.error)?.error ?? null,
  };
}

/**
 * Compare a run against a captured baseline.
 *
 * Regression is measured on p95 with a tolerance, plus an absolute floor so a
 * fast endpoint does not trip on jitter (30ms -> 40ms is +33% but irrelevant).
 * A path missing from the baseline is reported, not silently passed — otherwise
 * adding a path would quietly opt it out of the comparison.
 */
export function compareToBaseline(summaries, baseline, opts = {}) {
  const tolerancePct = opts.tolerancePct ?? 25;
  // 100ms, not 50: a first live run flagged a 93ms endpoint at 146ms as a
  // regression on an UNCHANGED system — p95 over a few dozen samples simply
  // moves that much. A gate that fails when nothing changed is a gate people
  // switch off, which costs more than the sensitivity it buys on fast paths.
  const floorMs = opts.floorMs ?? 100;
  const byPath = new Map((baseline?.paths ?? []).map((p) => [p.path, p]));
  const regressions = [];
  const missing = [];
  /**
   * Latency scales with load, so a baseline captured at a different concurrency
   * is not comparable — the numbers would look better or worse for a reason
   * that has nothing to do with the change under test.
   */
  const concurrencyMismatch =
    baseline?.concurrency !== undefined &&
    opts.concurrency !== undefined &&
    Number(baseline.concurrency) !== Number(opts.concurrency)
      ? { baseline: Number(baseline.concurrency), current: Number(opts.concurrency) }
      : null;

  for (const summary of summaries) {
    const base = byPath.get(summary.path);
    if (!base) {
      missing.push(summary.path);
      continue;
    }
    const allowed = Math.max(base.p95Ms * (1 + tolerancePct / 100), base.p95Ms + floorMs);
    if (summary.p95Ms > allowed) {
      regressions.push({
        path: summary.path,
        baselineP95Ms: base.p95Ms,
        currentP95Ms: summary.p95Ms,
        allowedP95Ms: allowed,
      });
    }
  }
  return { regressions, missing, concurrencyMismatch };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const baseUrl = process.env.SCALE_SMOKE_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  const concurrency = positiveInteger(process.env.SCALE_SMOKE_CONCURRENCY, 50);
  const p95BudgetMs = positiveInteger(process.env.SCALE_SMOKE_P95_BUDGET_MS, 2500);
  const expectedStatus = positiveInteger(process.env.SCALE_SMOKE_EXPECT_STATUS, 200);
  const paths = resolvePaths();

  const cookieFile = arg('--cookies') ?? process.env.SCALE_SMOKE_COOKIE_FILE;
  let cookieHeader = null;
  try {
    cookieHeader = loadCookieHeader(cookieFile);
  } catch (error) {
    console.error(
      `[scale-smoke] ERROR: could not read cookie file ${cookieFile}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // A gated path with no session would measure the login redirect. Refuse
  // rather than report a meaningless pass.
  const needsAuth = paths.some((p) => p.auth);
  if (needsAuth && !cookieHeader) {
    console.error(
      '[scale-smoke] ERROR: authenticated paths requested but no session cookie supplied.\n' +
        '  Mint one:  npx tsx scripts/qa/mint-qa-session.ts --out /tmp/qa-cookies.json\n' +
        '  Then pass: SCALE_SMOKE_COOKIE_FILE=/tmp/qa-cookies.json (or --cookies <file>)',
    );
    process.exit(1);
  }

  console.log(
    `[scale-smoke] base=${baseUrl} concurrency=${concurrency} p95BudgetMs=${p95BudgetMs} ` +
      `expect=${expectedStatus} paths=${paths.length} authenticated=${cookieHeader ? 'yes' : 'no'}`,
  );

  const summaries = [];
  for (const spec of paths) {
    const summary = await smokePath(baseUrl, spec, concurrency, {
      cookieHeader,
      expectedStatus,
      fetchImpl: fetch,
    });
    summaries.push(summary);
    console.log(
      `[scale-smoke] ${summary.auth ? '[auth] ' : ''}${summary.path} requests=${summary.requests} ` +
        `failures=${summary.failures} p50=${Math.round(summary.p50Ms)}ms p95=${Math.round(summary.p95Ms)}ms ` +
        `max=${Math.round(summary.maxMs)}ms statuses=${JSON.stringify(summary.statuses)}`,
    );
    if (summary.firstError) {
      console.log(`[scale-smoke] ${summary.path} firstError=${summary.firstError}`);
    }
  }

  const baselineOut = arg('--baseline-out') ?? process.env.SCALE_SMOKE_BASELINE_OUT;
  if (baselineOut) {
    const doc = {
      capturedAt: new Date().toISOString(),
      baseUrl,
      concurrency,
      expectedStatus,
      paths: summaries.map((s) => ({
        path: s.path,
        auth: s.auth,
        p50Ms: Math.round(s.p50Ms),
        p95Ms: Math.round(s.p95Ms),
        maxMs: Math.round(s.maxMs),
      })),
    };
    writeFileSync(baselineOut, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    console.log(`[scale-smoke] baseline written to ${baselineOut}`);
  }

  const baselineIn = arg('--baseline') ?? process.env.SCALE_SMOKE_BASELINE;
  let baselineFailed = false;
  if (baselineIn) {
    const baseline = JSON.parse(readFileSync(baselineIn, 'utf8'));
    const tolerancePct = positiveInteger(process.env.SCALE_SMOKE_BASELINE_TOLERANCE_PCT, 25);
    const { regressions, missing, concurrencyMismatch } = compareToBaseline(summaries, baseline, {
      tolerancePct,
      concurrency,
    });
    if (concurrencyMismatch) {
      // Refuse rather than print a comparison that cannot mean anything.
      console.error(
        `[scale-smoke] ERROR: baseline was captured at concurrency=${concurrencyMismatch.baseline} ` +
          `but this run used ${concurrencyMismatch.current}. Latency scales with load — re-run at ` +
          'the baseline concurrency, or capture a new baseline.',
      );
      process.exit(1);
    }
    for (const r of regressions) {
      console.error(
        `[scale-smoke] REGRESSION ${r.path} p95 ${Math.round(r.currentP95Ms)}ms > ` +
          `allowed ${Math.round(r.allowedP95Ms)}ms (baseline ${Math.round(r.baselineP95Ms)}ms)`,
      );
    }
    // Not silent: a path absent from the baseline is unmeasured, not passing.
    for (const path of missing) {
      console.warn(`[scale-smoke] NOTE ${path} has no baseline entry — not compared`);
    }
    baselineFailed = regressions.length > 0;
  }

  const failed = summaries.filter((s) => s.failures > 0 || s.p95Ms > p95BudgetMs);
  if (failed.length > 0 || baselineFailed) {
    console.error('[scale-smoke] FAILED: status failures, p95 budget, or baseline regression');
    process.exit(1);
  }

  console.log('[scale-smoke] passed');
}

// Only run when invoked directly, so the helpers above stay importable by tests.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly || process.env.SCALE_SMOKE_FORCE_RUN === '1') {
  main().catch((error) => {
    console.error(`[scale-smoke] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
