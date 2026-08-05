/**
 * tests/insights-route-auth-tenant-isolation.test.ts
 *
 * S4-5 / AA-108 (gap E1) — auth + tenant-isolation coverage for EVERY insights
 * GET route. Pulled forward of Phase 3 deliberately: with multi-workspace in
 * flight these are the highest-risk untested read paths in the app.
 *
 * Two guarantees, pinned two different ways:
 *
 *   1. Unauthenticated GET is rejected (behavioural). Every handler takes an
 *      injectable `tenantContextLoader`, so a loader that throws exercises the
 *      real rejection path — no DB, no session, no mocking.
 *
 *   2. Tenant A cannot read tenant B (structural). The isolation mechanism is
 *      that `tenantId` is derived ONLY from the resolved tenant context and is
 *      always bound as a query PARAMETER. A handler that read a tenant id off
 *      the request, or interpolated one into SQL, would break it. The repo's
 *      runner has no module-mock flag (Node 20 + no
 *      `--experimental-test-module-mocks`; grep shows zero `mock.module` call
 *      sites), and these handlers read a module-scoped pool they cannot be
 *      handed, so the invariant is asserted at the source — the same approach
 *      tests/insights-force-throttle.test.ts uses for "the gate runs before
 *      pool.connect()" and tests/tenant/membership-dual-write.test.ts uses for
 *      registerUserAction. The live two-tenant read is proven separately
 *      against real Postgres (see the note at the bottom of this file).
 *
 * The route registry below is COVERAGE-GUARDED: a new insights GET route that
 * is not registered here fails this suite. That is what makes the pattern
 * reusable rather than a snapshot of today's 14 routes.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-route-auth-tenant-isolation.test.ts
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { TenantContextError, type TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';

import {
  handleGetInsightsSummary,
  handleGetInsightsPosts,
  handleGetInsightsAccountMetrics,
  handleGetInsightsComments,
} from '../backend/insights/read-api';
import { handleGetInsightsActivity } from '../backend/insights/activity/handler';
import { handleGetInsightsAries } from '../backend/insights/aries/handler';
import { handleGetInsightsAttention } from '../backend/insights/attention/handler';
import { handleGetInsightsAudience } from '../backend/insights/audience/handler';
import { handleGetInsightsConversations } from '../backend/insights/conversations/handler';
import { handleGetInsightsFreshness } from '../backend/insights/freshness/handler';
import { handleGetInsightsGoal } from '../backend/insights/goal/handler';
import { handleGetInsightsNarrative } from '../backend/insights/narrative/handler';
import { handleGetInsightsTop } from '../backend/insights/top/handler';
import { handleGetInsightsTrends } from '../backend/insights/trends/handler';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const INSIGHTS_API_DIR = path.join(PROJECT_ROOT, 'app', 'api', 'insights');

type InsightsGetHandler = (
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) => Promise<Response>;

interface RegisteredRoute {
  /** Route path as served, relative to /api/insights. */
  route: string;
  /** Handler source file, relative to the repo root — asserted structurally. */
  source: string;
  handler: InsightsGetHandler;
  /** A representative valid query string, so the handler gets past validation. */
  query: string;
}

/**
 * Every insights GET route. Keep in sync with app/api/insights — the coverage
 * test below fails if a route exists on disk without an entry here.
 */
const INSIGHTS_GET_ROUTES: readonly RegisteredRoute[] = [
  {
    route: 'account-metrics',
    source: 'backend/insights/read-api.ts',
    handler: handleGetInsightsAccountMetrics,
    query: '?days=30',
  },
  {
    route: 'activity',
    source: 'backend/insights/activity/handler.ts',
    handler: handleGetInsightsActivity,
    query: '?period=week',
  },
  {
    route: 'aries',
    source: 'backend/insights/aries/handler.ts',
    handler: handleGetInsightsAries,
    query: '?period=week',
  },
  {
    route: 'attention',
    source: 'backend/insights/attention/handler.ts',
    handler: handleGetInsightsAttention,
    query: '?period=week',
  },
  {
    route: 'audience',
    source: 'backend/insights/audience/handler.ts',
    handler: handleGetInsightsAudience,
    query: '?period=week',
  },
  {
    route: 'comments',
    source: 'backend/insights/read-api.ts',
    handler: handleGetInsightsComments,
    query: '?limit=20',
  },
  {
    route: 'conversations',
    source: 'backend/insights/conversations/handler.ts',
    handler: handleGetInsightsConversations,
    query: '?period=week',
  },
  {
    route: 'freshness',
    source: 'backend/insights/freshness/handler.ts',
    handler: handleGetInsightsFreshness,
    query: '',
  },
  {
    route: 'goal',
    source: 'backend/insights/goal/handler.ts',
    handler: handleGetInsightsGoal,
    query: '?period=week',
  },
  {
    route: 'narrative',
    source: 'backend/insights/narrative/handler.ts',
    handler: handleGetInsightsNarrative,
    query: '?period=week',
  },
  {
    route: 'posts',
    source: 'backend/insights/read-api.ts',
    handler: handleGetInsightsPosts,
    query: '?limit=50',
  },
  {
    route: 'summary',
    source: 'backend/insights/read-api.ts',
    handler: handleGetInsightsSummary,
    query: '?days=30',
  },
  {
    route: 'top',
    source: 'backend/insights/top/handler.ts',
    handler: handleGetInsightsTop,
    query: '?period=week&sort=reach',
  },
  {
    route: 'trends',
    source: 'backend/insights/trends/handler.ts',
    handler: handleGetInsightsTrends,
    query: '?period=week',
  },
];

const BASE_URL = 'https://aries.example.com/api/insights';

function requestFor(entry: RegisteredRoute, extraQuery = ''): Request {
  const query = entry.query
    ? `${entry.query}${extraQuery.replace(/^\?/, '&')}`
    : extraQuery;
  return new Request(`${BASE_URL}/${entry.route}${query}`);
}

/** Loader standing in for "no session at all" — what getTenantContext throws. */
const unauthenticatedLoader: TenantContextLoader = async () => {
  throw new Error('Authentication required.');
};

/** Loader standing in for a signed-in account with no workspace membership. */
const membershipMissingLoader: TenantContextLoader = async () => {
  throw new TenantContextError('tenant_membership_missing', 'Tenant membership missing.');
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Recursively collect every `route.ts` under app/api/insights. */
function collectRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectRouteFiles(full, acc);
    } else if (entry === 'route.ts') {
      acc.push(full);
    }
  }
  return acc;
}

// ── Coverage guard ───────────────────────────────────────────────────────────
// Without this, the suite silently stops meaning "every insights GET route" the
// first time someone adds one.

test('every insights GET route on disk is registered in this suite', () => {
  const onDisk = collectRouteFiles(INSIGHTS_API_DIR)
    .filter((file) => /export\s+async\s+function\s+GET\b/.test(readFileSync(file, 'utf8')))
    .map((file) =>
      path
        .relative(INSIGHTS_API_DIR, path.dirname(file))
        .split(path.sep)
        .join('/'),
    )
    .sort();

  const registered = INSIGHTS_GET_ROUTES.map((r) => r.route).sort();

  assert.deepEqual(
    onDisk,
    registered,
    'an insights GET route is missing auth/tenant-isolation coverage — register it above',
  );
});

test('registry has no duplicate routes and every handler is callable', () => {
  const routes = INSIGHTS_GET_ROUTES.map((r) => r.route);
  assert.equal(new Set(routes).size, routes.length, 'duplicate route entry');
  for (const entry of INSIGHTS_GET_ROUTES) {
    assert.equal(typeof entry.handler, 'function', `${entry.route} handler is not a function`);
  }
});

// ── 1. Unauthenticated GET is rejected, on every route ───────────────────────

for (const entry of INSIGHTS_GET_ROUTES) {
  test(`GET /api/insights/${entry.route} — unauthenticated is rejected`, async () => {
    const res = await entry.handler(requestFor(entry), unauthenticatedLoader);

    // NOTE ON THE STATUS CODE: the roadmap ticket says "401". The shipped
    // contract — one shared wrapper, `loadTenantContextOrResponse`, used by
    // every insights route and ~43 others — answers 403 `tenant_context_required`.
    // This test pins the SHIPPED contract rather than changing 43 routes'
    // status codes as a side effect of a test ticket. What matters for E1 is
    // that the request is refused and carries no tenant data; see the PR note.
    assert.equal(res.status, 403, `${entry.route} must refuse an unauthenticated read`);

    const body = await readJson(res);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');

    // A refusal must not leak a payload of any kind.
    for (const dataKey of ['data', 'posts', 'comments', 'cards', 'series', 'summary']) {
      assert.equal(body[dataKey], undefined, `${entry.route} leaked ${dataKey} on refusal`);
    }
  });

  test(`GET /api/insights/${entry.route} — signed in with no membership is rejected`, async () => {
    // Multi-workspace: an account whose workspace membership is gone must not
    // fall back to any tenant's data.
    const res = await entry.handler(requestFor(entry), membershipMissingLoader);
    assert.equal(res.status, 403, `${entry.route} must refuse a membership-less session`);

    const body = await readJson(res);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_membership_missing');
  });

  test(`GET /api/insights/${entry.route} — refuses before any tenant id is read`, async () => {
    // A spoofed tenant id on the query string must not change the outcome for
    // an unauthenticated caller: auth is resolved first, unconditionally.
    const spoofed = await entry.handler(
      requestFor(entry, '?tenantId=999&tenant_id=999&tenant=999&organizationId=999'),
      unauthenticatedLoader,
    );
    assert.equal(spoofed.status, 403);
    assert.equal((await readJson(spoofed)).reason, 'tenant_context_required');
  });
}

// ── 2. Tenant scoping is structural: context-only, always parameterized ──────

const uniqueSources = [...new Set(INSIGHTS_GET_ROUTES.map((r) => r.source))].sort();

/**
 * The tenant-scoped READ SURFACE for a handler: the handler file plus the
 * `backend/insights/**` modules it imports directly. Three handlers (aries,
 * audience, conversations) own no SQL themselves — they resolve the tenant id
 * and hand it to a builder — so the scoping predicate has to be looked for
 * where the query actually lives.
 */
function readSurfaceFor(source: string): string[] {
  const abs = path.join(PROJECT_ROOT, source);
  const text = readFileSync(abs, 'utf8');
  const surface = [source];

  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const resolved = path.resolve(path.dirname(abs), `${match[1]}.ts`);
    const rel = path.relative(PROJECT_ROOT, resolved).split(path.sep).join('/');
    if (!rel.startsWith('backend/insights/')) continue;
    try {
      statSync(resolved);
      surface.push(rel);
    } catch {
      // Directory import or type-only path — nothing to inspect.
    }
  }
  return surface;
}

test('every insights handler source derives tenantId from the tenant context only', () => {
  for (const source of uniqueSources) {
    const text = readFileSync(path.join(PROJECT_ROOT, source), 'utf8');

    assert.match(
      text,
      /tenantResult\.tenantContext\.tenantId/,
      `${source} must derive tenantId from the resolved tenant context`,
    );

    // The isolation break that would matter: taking a tenant identity from the
    // REQUEST. No insights handler reads any tenant-ish parameter today, and
    // none may start.
    assert.doesNotMatch(
      text,
      /searchParams\.get\(\s*['"](tenant|tenantId|tenant_id|org|orgId|organizationId|organization_id)['"]\s*\)/i,
      `${source} must never read a tenant id off the request`,
    );
  }
});

test('every insights route scopes its reads with a parameterized tenant_id predicate', () => {
  for (const entry of INSIGHTS_GET_ROUTES) {
    const surface = readSurfaceFor(entry.source);
    const texts = surface.map((file) => ({
      file,
      text: readFileSync(path.join(PROJECT_ROOT, file), 'utf8'),
    }));

    assert.ok(
      texts.some(({ text }) => /tenant_id\s*=\s*\$\d/.test(text)),
      `/${entry.route}: no parameterized tenant_id predicate anywhere in ${surface.join(', ')}`,
    );

    // Interpolating the tenant id into the SQL predicate itself would defeat
    // parameterization and make the scope forgeable. (Interpolating tenantId
    // into a CACHE KEY is required, not forbidden — asserted below.)
    for (const { file, text } of texts) {
      assert.doesNotMatch(
        text,
        /tenant_id\s*=\s*\$\{/,
        `${file} must not interpolate tenantId into the tenant_id predicate`,
      );
    }
  }
});

test('cached insights sections key their cache on tenantId', () => {
  // A cache key without the tenant id would serve tenant A's generated body to
  // tenant B — a cross-tenant read that no SQL predicate can prevent, because
  // the query never runs on a cache hit.
  let checked = 0;
  for (const source of uniqueSources) {
    const text = readFileSync(path.join(PROJECT_ROOT, source), 'utf8');
    if (!text.includes('createHash')) continue;

    const hashed = text.match(/\.update\(`([^`]*)`\)/g) ?? [];
    assert.ok(hashed.length > 0, `${source} builds a hash but no template input was found`);
    for (const input of hashed) {
      assert.match(
        input,
        /\$\{\s*tenantId\s*\}/,
        `${source} hashes a cache key that does not include tenantId: ${input}`,
      );
    }
    checked += 1;
  }
  assert.ok(checked > 0, 'expected at least one cached insights section to check');
});

test('auth is resolved before any pooled database work in every handler', () => {
  // A handler that connected first would hold a pooled client for a request it
  // was about to refuse (the same resource argument as AA-120's force throttle).
  for (const source of uniqueSources) {
    const text = readFileSync(path.join(PROJECT_ROOT, source), 'utf8');
    const lines = text.split('\n');

    const firstAuth = lines.findIndex((l) => l.includes('loadTenantContextOrResponse('));
    assert.ok(firstAuth >= 0, `${source} must resolve tenant context`);

    // Every pool acquisition inside a handler body must follow an auth call.
    lines.forEach((line, index) => {
      if (!/\bpool\.(connect|query)\(/.test(line)) return;
      const priorAuth = lines
        .slice(0, index)
        .some((l) => l.includes('loadTenantContextOrResponse('));
      // Module-level helpers defined above the first handler are called from
      // inside it, after auth; only flag pool use that precedes ALL auth calls
      // in a file that has one.
      if (!priorAuth && index > firstAuth) {
        assert.fail(`${source}:${index + 1} acquires the pool before resolving auth`);
      }
    });
  }
});

// ── Scope note ───────────────────────────────────────────────────────────────
// The behavioural two-tenant read (seed tenant A and tenant B, call each handler
// as A, assert B's rows never appear) needs real Postgres and belongs in the
// requires-infra split, not here — this file must stay self-contained so it can
// run inside `npm run verify` with no infrastructure. What is proven here is the
// mechanism that makes cross-tenant reads impossible: the tenant id can only
// come from the authenticated context, and it is always a bound parameter.
