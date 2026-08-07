import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { handleGetWeeklyResults } from '../app/api/dashboard/weekly-results/route';
import { isWeeklyResultsEnabled } from '../backend/marketing/weekly-results-env';
import { TenantContextError, type TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';

/**
 * S5-1 / AA-110 — GET /api/dashboard/weekly-results.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/weekly-results-route.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const URL_BASE = 'https://aries.example.com/api/dashboard/weekly-results';

function tenantLoader(tenantId: string): TenantContextLoader {
  return async () =>
    ({
      tenantId,
      tenantSlug: `tenant-${tenantId}`,
      userId: 'user-1',
      role: 'tenant_admin',
    }) as unknown as TenantContext;
}

const unauthenticated: TenantContextLoader = async () => {
  throw new Error('Authentication required.');
};

/**
 * Set the flag for the duration of an ASYNC body. Must await `fn()` inside the
 * try — a sync `return fn()` restores the env var the moment the callback hits
 * its first await, so any later iteration reads the restored value.
 */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.ARIES_WEEKLY_RESULTS_ENABLED;
  if (value === undefined) delete process.env.ARIES_WEEKLY_RESULTS_ENABLED;
  else process.env.ARIES_WEEKLY_RESULTS_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.ARIES_WEEKLY_RESULTS_ENABLED;
    else process.env.ARIES_WEEKLY_RESULTS_ENABLED = prior;
  }
}

// ── Flag helper ──────────────────────────────────────────────────────────────

test('flag helper accepts the house truthy vocabulary and defaults OFF', () => {
  for (const on of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
    assert.equal(isWeeklyResultsEnabled({ ARIES_WEEKLY_RESULTS_ENABLED: on }), true, on);
  }
  for (const off of ['0', 'false', 'no', 'off', '', '   ', 'maybe', undefined]) {
    assert.equal(
      isWeeklyResultsEnabled({ ARIES_WEEKLY_RESULTS_ENABLED: off }),
      false,
      String(off),
    );
  }
  assert.equal(isWeeklyResultsEnabled({}), false, 'unset must be OFF');
});

// ── Gate behaviour ───────────────────────────────────────────────────────────

test('flag OFF returns {enabled:false} and resolves NO tenant context', async () => {
  // The gate must run before the tenant lookup and before any pooled client is
  // taken, so a disabled deployment pays nothing for this route. A loader that
  // throws proves it was never called.
  await withFlag(undefined, async () => {
    let loaderCalls = 0;
    const spy: TenantContextLoader = async () => {
      loaderCalls += 1;
      throw new Error('loader must not run while the flag is off');
    };
    const res = await handleGetWeeklyResults(new Request(URL_BASE), spy);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: false });
    assert.equal(loaderCalls, 0, 'no tenant resolution while disabled');
  });
});

test('flag ON refuses an unauthenticated caller', async () => {
  await withFlag('1', async () => {
    const res = await handleGetWeeklyResults(new Request(URL_BASE), unauthenticated);
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');
    assert.equal(body.report, undefined, 'a refusal must carry no report');
  });
});

test('flag ON refuses a session with no workspace membership', async () => {
  await withFlag('1', async () => {
    const res = await handleGetWeeklyResults(new Request(URL_BASE), async () => {
      throw new TenantContextError('tenant_membership_missing', 'no membership');
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, 'tenant_membership_missing');
  });
});

test('a non-numeric tenant id is refused rather than coerced', async () => {
  // posts.tenant_id is INTEGER; NaN would silently match nothing and render an
  // all-zero report that looks like a genuinely quiet week.
  await withFlag('1', async () => {
    for (const bad of ['not-a-number', '', '0', '-3']) {
      const res = await handleGetWeeklyResults(new Request(URL_BASE), tenantLoader(bad));
      assert.equal(res.status, 403, `tenant ${JSON.stringify(bad)} must be refused`);
    }
  });
});

// ── Source-level contracts ───────────────────────────────────────────────────

const routeSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'api', 'dashboard', 'weekly-results', 'route.ts'),
  'utf8',
);

test('the flag gate precedes tenant resolution in the source', () => {
  // Compare CALL SITES, not the import lines — every import sits above the
  // handler body, so matching the bare identifier would compare nothing useful.
  const gateAt = routeSource.indexOf('if (!isWeeklyResultsEnabled())');
  const tenantAt = routeSource.indexOf('await loadTenantContextOrResponse(');
  assert.ok(gateAt > 0, 'gate call site not found');
  assert.ok(tenantAt > 0, 'tenant call site not found');
  assert.ok(gateAt < tenantAt, 'the disabled path must short-circuit before any DB work');
});

test('the tenant id comes only from the resolved context, never the request', () => {
  assert.match(routeSource, /tenantResult\.tenantContext\.tenantId/);
  assert.doesNotMatch(
    routeSource,
    /searchParams\.get\(\s*['"](tenant|tenantId|tenant_id|organizationId)['"]\s*\)/i,
  );
});

test('a build failure returns a safe body, never the raw error', () => {
  assert.match(routeSource, /weekly_results_unavailable/);
  // The caught error is logged server-side but must not be serialized to the client.
  assert.doesNotMatch(routeSource, /json\([^)]*error:\s*(error|String\(error\)|err)/);
});

test('the route is read-only', () => {
  // The MVP slice writes nothing at all — that is why its rollback is the flag
  // alone, with no migration to reverse.
  assert.doesNotMatch(routeSource, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(routeSource, /export async function (POST|PUT|PATCH|DELETE)/);
});

test('the page reads the flag server-side so a disabled screen mounts nothing', () => {
  const page = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'dashboard', 'results', 'page.tsx'),
    'utf8',
  );
  assert.match(page, /isWeeklyResultsEnabled\(\)/);
  assert.match(page, /WeeklyResultsReport/);
  // Flag OFF must still render today's screen — unchanged.
  assert.match(page, /AriesResultsScreen/);
});
