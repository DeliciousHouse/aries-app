/**
 * tests/insights-force-throttle.test.ts
 *
 * S7-2 / AA-120 (gap D2) — the per-tenant/section bound on the authenticated
 * `?force=true` cache bypass across the six cached insights sections.
 *
 * The acceptance bar from the roadmap is two-sided, and both sides are pinned
 * here: "Browser retry works; scripted hammering doesn't reach the pool."
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-force-throttle.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  DEFAULT_FORCE_THROTTLE_CAPACITY,
  DEFAULT_FORCE_THROTTLE_WINDOW_MS,
  checkInsightsForceThrottle,
  consumeInsightsForceToken,
  forceThrottleCapacity,
  forceThrottleWindowMs,
  insightsForceThrottledResponse,
  isInsightsForceThrottleEnabled,
  __forceThrottleBucketCountForTests,
  __resetInsightsForceThrottleForTests,
  type CachedInsightsSection,
} from '../backend/insights/force-throttle';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...segments: string[]): string =>
  readFileSync(path.join(PROJECT_ROOT, ...segments), 'utf8');

const SECTIONS: readonly CachedInsightsSection[] = [
  'narrative',
  'goal',
  'attention',
  'activity',
  'trends',
  'top',
  // S7-3/AA-121 added caching + `force` to these three. They read the
  // micro-cache rather than insights_narratives, but bypass it on force and
  // rebuild through the same pool, so they carry the same hazard and belong to
  // the same limiter. Listing them here is what extends every structural check
  // below to cover them.
  'aries',
  'audience',
  'conversations',
  // AA-229/PR2b: Section 10 — Weekly Recap. Also micro-cached, but rebuilds
  // on a literal `pool.connect()` in its own handler (matching `top`'s
  // pattern), so the generic scan below finds it directly and it needs no
  // entry in BUILDER_SECTIONS.
  'weekly-recap',
] as const;

/**
 * The micro-cache trio reach the pool through a builder rather than a literal
 * `pool.connect()`/`pool.query` in the handler, so the generic scan above finds
 * no marker to order against and would pass vacuously for them. Their pooled
 * work is the builder call, so that is what the gate has to precede.
 */
const BUILDER_SECTIONS: ReadonlyArray<{ section: CachedInsightsSection; builder: string }> = [
  { section: 'aries', builder: 'await buildWorkingWithAriesSnapshot(' },
  { section: 'audience', builder: 'await buildAudienceSnapshot(' },
  { section: 'conversations', builder: 'await buildConversationsSnapshot(' },
] as const;

const T0 = 1_800_000_000_000; // fixed clock; the module takes `nowMs`, so no sleeping

function reset(): void {
  __resetInsightsForceThrottleForTests();
}

// ── The load-bearing invariant: the gate runs BEFORE pool.connect() ───────────

test('a throttled request reaches no database work in any handler', () => {
  // This is the whole point of the ticket. A throttle placed after the pooled
  // client is acquired would let a denied request occupy the exact resource it
  // exists to protect, so the fix would look correct and relieve nothing.
  //
  // The assertion is deliberately "before ANY pool use", not merely "before the
  // connect": the narrative handler runs a platform-connection query of its own
  // ahead of the rebuild, so a gate that cleared only the connect would still
  // let a throttled force hit the pool on that one section.
  for (const section of SECTIONS) {
    const source = read('backend', 'insights', section, 'handler.ts');

    // Match the call, not the prose — an explanatory comment naming the connect
    // would otherwise satisfy a bare substring search.
    const gateAt = source.indexOf('checkInsightsForceThrottle(force,');
    assert.notEqual(gateAt, -1, `${section} handler must call checkInsightsForceThrottle`);

    const handlerAt = source.indexOf('export async function handleGetInsights');
    assert.notEqual(handlerAt, -1, `${section} must export a handler`);

    for (const poolUse of ['await pool.connect()', 'await pool.query']) {
      let at = source.indexOf(poolUse);
      while (at !== -1) {
        // Only pool use reachable on the request path matters; helpers defined
        // above the handler are called from inside it, so compare on call order
        // by requiring the gate to precede any pool use that sits after the
        // handler's own opening.
        if (at > handlerAt) {
          assert.ok(
            gateAt < at,
            `${section}: throttle (at ${gateAt}) must precede "${poolUse}" (at ${at})`,
          );
        }
        at = source.indexOf(poolUse, at + 1);
      }
    }
  }
});

test('the micro-cache sections throttle before their builder reaches the pool', () => {
  // The scan above orders the gate against literal pool use, which these three
  // handlers do not contain — their rebuild is behind a builder that opens the
  // client itself. Without this, adding them to SECTIONS would assert only that
  // the gate exists somewhere, not that it runs before the expensive work.
  for (const { section, builder } of BUILDER_SECTIONS) {
    const source = read('backend', 'insights', section, 'handler.ts');

    const gateAt = source.indexOf('checkInsightsForceThrottle(force,');
    assert.notEqual(gateAt, -1, `${section} handler must call checkInsightsForceThrottle`);

    const builderAt = source.indexOf(builder);
    assert.notEqual(builderAt, -1, `${section} handler must call ${builder}`);

    assert.ok(
      gateAt < builderAt,
      `${section}: throttle (at ${gateAt}) must precede "${builder}" (at ${builderAt})`,
    );
  }
});

test('a forced micro-cache request is throttled on the same bucket as any other section', () => {
  // Behavioural, not structural: drain the bucket for one of the new sections
  // and confirm it denies like the original six, so these are genuinely on the
  // limiter rather than merely mentioning it.
  reset();
  const capacity = DEFAULT_FORCE_THROTTLE_CAPACITY;
  for (let i = 0; i < capacity; i += 1) {
    assert.equal(
      checkInsightsForceThrottle(true, 42, 'aries', T0),
      null,
      `forced rebuild ${i + 1} of ${capacity} should be allowed`,
    );
  }
  const denied = checkInsightsForceThrottle(true, 42, 'aries', T0);
  assert.notEqual(denied, null, 'the request past capacity must be throttled');
  assert.equal(denied?.status, 429);

  // A different section keeps its own allowance — the per-(tenant, section)
  // granularity must hold for the new entries too.
  assert.equal(
    checkInsightsForceThrottle(true, 42, 'audience', T0),
    null,
    'draining aries must not lock out audience',
  );
  // And a different tenant is unaffected.
  assert.equal(checkInsightsForceThrottle(true, 43, 'aries', T0), null);
});

test('the narrative connection check runs after the throttle, not before it', () => {
  // Regression pin for the one section where the gate had to move above a
  // pre-existing query rather than merely above the connect.
  const source = read('backend', 'insights', 'narrative', 'handler.ts');
  const gateAt = source.indexOf('checkInsightsForceThrottle(force,');
  const checkAt = source.indexOf('await checkPlatformConnection(');
  assert.notEqual(checkAt, -1, 'narrative is expected to check platform connection');
  assert.ok(
    gateAt < checkAt,
    `narrative must throttle before its connection query (gate ${gateAt}, check ${checkAt})`,
  );
});

test('every cached handler returns the throttle response instead of falling through', () => {
  for (const section of SECTIONS) {
    const source = read('backend', 'insights', section, 'handler.ts');
    assert.match(
      source,
      /if \(throttled\) return throttled;/,
      `${section} handler must return the 429 rather than continue`,
    );
  }
});

test('each handler passes its own section key to the throttle', () => {
  // A copy-paste that left another section's literal in place would merge two
  // sections onto one bucket, so a user retrying one could lock out the other.
  for (const section of SECTIONS) {
    const source = read('backend', 'insights', section, 'handler.ts');
    assert.match(
      source,
      new RegExp(`checkInsightsForceThrottle\\(force, tenantId, '${section}'\\)`),
      `${section} handler must key the throttle on '${section}'`,
    );
  }
});

// ── Bucket mechanics ─────────────────────────────────────────────────────────

test('an unforced request consumes nothing', () => {
  reset();
  for (let i = 0; i < 100; i++) {
    assert.equal(checkInsightsForceThrottle(false, 1, 'goal', T0), null);
  }
  assert.equal(
    __forceThrottleBucketCountForTests(),
    0,
    'cache-served requests must not create throttle state at all',
  );
});

test('a burst up to capacity is allowed, and the next one is denied', () => {
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    const decision = consumeInsightsForceToken(1, 'goal', T0);
    assert.equal(decision.allowed, true, `force #${i + 1} should be allowed`);
    assert.equal(decision.retryAfterMs, 0);
  }

  const denied = consumeInsightsForceToken(1, 'goal', T0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0, 'a denial must say how long to wait');
});

test('scripted hammering stays bounded no matter how many attempts arrive', () => {
  // The "scripted hammering doesn't reach the pool" half of the acceptance bar.
  reset();
  let allowed = 0;
  for (let i = 0; i < 1000; i++) {
    if (consumeInsightsForceToken(7, 'trends', T0).allowed) allowed++;
  }
  assert.equal(
    allowed,
    DEFAULT_FORCE_THROTTLE_CAPACITY,
    '1000 instantaneous attempts must yield exactly the burst allowance',
  );
});

test('tokens refill over the window and a full window restores the whole burst', () => {
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    consumeInsightsForceToken(1, 'goal', T0);
  }
  assert.equal(consumeInsightsForceToken(1, 'goal', T0).allowed, false);

  // One window later the bucket is full again.
  const later = T0 + DEFAULT_FORCE_THROTTLE_WINDOW_MS;
  let allowed = 0;
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY * 3; i++) {
    if (consumeInsightsForceToken(1, 'goal', later).allowed) allowed++;
  }
  assert.equal(allowed, DEFAULT_FORCE_THROTTLE_CAPACITY);
});

test('a partial wait buys a proportional number of tokens, not all of them', () => {
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    consumeInsightsForceToken(1, 'goal', T0);
  }

  // Wait exactly long enough to earn 2 tokens.
  const perToken = DEFAULT_FORCE_THROTTLE_WINDOW_MS / DEFAULT_FORCE_THROTTLE_CAPACITY;
  const later = T0 + perToken * 2;

  assert.equal(consumeInsightsForceToken(1, 'goal', later).allowed, true);
  assert.equal(consumeInsightsForceToken(1, 'goal', later).allowed, true);
  assert.equal(consumeInsightsForceToken(1, 'goal', later).allowed, false);
});

test('hammering while throttled does not push the recovery further out', () => {
  // A limiter that reset its window on every denied attempt would lock out a
  // frustrated user indefinitely — and force=true is reachable only from the
  // Retry button, so that user is already staring at a broken panel.
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    consumeInsightsForceToken(1, 'goal', T0);
  }

  const firstDenial = consumeInsightsForceToken(1, 'goal', T0);
  for (let i = 0; i < 50; i++) consumeInsightsForceToken(1, 'goal', T0 + i);

  const perToken = DEFAULT_FORCE_THROTTLE_WINDOW_MS / DEFAULT_FORCE_THROTTLE_CAPACITY;
  assert.ok(
    firstDenial.retryAfterMs <= Math.ceil(perToken) + 1,
    'the first denial should be about one token away from recovery',
  );
  assert.equal(
    consumeInsightsForceToken(1, 'goal', T0 + Math.ceil(perToken)).allowed,
    true,
    'the promised wait must actually be enough, despite the denied attempts in between',
  );
});

test('the reported retryAfterMs shrinks as the wait elapses', () => {
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    consumeInsightsForceToken(1, 'goal', T0);
  }
  const early = consumeInsightsForceToken(1, 'goal', T0).retryAfterMs;
  const late = consumeInsightsForceToken(1, 'goal', T0 + 10_000).retryAfterMs;
  assert.ok(late < early, `expected the wait to shrink (${late} < ${early})`);
  assert.ok(late > 0);
});

// ── Isolation ────────────────────────────────────────────────────────────────

test('sections do not share a bucket', () => {
  // Draining one section must not lock a user out of retrying another.
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    consumeInsightsForceToken(1, 'goal', T0);
  }
  assert.equal(consumeInsightsForceToken(1, 'goal', T0).allowed, false);

  for (const section of SECTIONS) {
    if (section === 'goal') continue;
    assert.equal(
      consumeInsightsForceToken(1, section, T0).allowed,
      true,
      `${section} must have its own allowance`,
    );
  }
});

test('varying period or platform cannot mint extra allowance', () => {
  // Five of the six handlers never validate `platform` — they just lowercase
  // whatever arrives — so a bucket keyed on it would hand a caller a fresh full
  // allowance per junk value and the limit would be decorative. The signature
  // takes neither, which closes that by construction; this pins the intent so a
  // later "make the throttle more precise" change has to confront it.
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    assert.equal(consumeInsightsForceToken(1, 'goal', T0).allowed, true);
  }
  assert.equal(consumeInsightsForceToken(1, 'goal', T0).allowed, false);
  assert.equal(
    __forceThrottleBucketCountForTests(),
    1,
    'one tenant hammering one section must occupy exactly one bucket',
  );

  const source = read('backend', 'insights', 'force-throttle.ts');
  assert.match(
    source,
    /function bucketKey\(tenantId: number, section: CachedInsightsSection\)/,
    'the bucket key must remain (tenant, section) only',
  );
});

test('tenants do not share a bucket', () => {
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    consumeInsightsForceToken(1, 'goal', T0);
  }
  assert.equal(consumeInsightsForceToken(1, 'goal', T0).allowed, false);
  assert.equal(
    consumeInsightsForceToken(2, 'goal', T0).allowed,
    true,
    'one tenant hammering must never throttle another',
  );
});

// ── Flag + configuration ─────────────────────────────────────────────────────

test('the limiter is ON by default — a rate limit that ships off protects nothing', () => {
  assert.equal(isInsightsForceThrottleEnabled({}), true);
  assert.equal(isInsightsForceThrottleEnabled({ ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED: '' }), true);
});

test('only an explicit falsy value disables it; a typo fails safe (still limited)', () => {
  for (const raw of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
    assert.equal(
      isInsightsForceThrottleEnabled({ ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED: raw }),
      false,
      `${JSON.stringify(raw)} should disable`,
    );
  }
  for (const raw of ['1', 'true', 'yes', 'on', 'ON', 'yolo', 'flase']) {
    assert.equal(
      isInsightsForceThrottleEnabled({ ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED: raw }),
      true,
      `${JSON.stringify(raw)} must leave the limiter enabled`,
    );
  }
});

test('disabling the flag allows every forced request', () => {
  reset();
  const env = { ARIES_INSIGHTS_FORCE_THROTTLE_ENABLED: '0' };
  for (let i = 0; i < 100; i++) {
    assert.equal(consumeInsightsForceToken(1, 'goal', T0, env).allowed, true);
  }
  assert.equal(
    __forceThrottleBucketCountForTests(),
    0,
    'a disabled limiter must not accumulate state either',
  );
});

test('capacity and window fall back to defaults on unusable values', () => {
  for (const bad of ['0', '-5', 'abc', '', '1e3']) {
    assert.equal(
      forceThrottleCapacity({ ARIES_INSIGHTS_FORCE_THROTTLE_BURST: bad }),
      DEFAULT_FORCE_THROTTLE_CAPACITY,
      `capacity ${JSON.stringify(bad)} should fall back`,
    );
    assert.equal(
      forceThrottleWindowMs({ ARIES_INSIGHTS_FORCE_THROTTLE_WINDOW_MS: bad }),
      DEFAULT_FORCE_THROTTLE_WINDOW_MS,
      `window ${JSON.stringify(bad)} should fall back`,
    );
  }
  assert.equal(forceThrottleCapacity({ ARIES_INSIGHTS_FORCE_THROTTLE_BURST: '12' }), 12);
  assert.equal(
    forceThrottleWindowMs({ ARIES_INSIGHTS_FORCE_THROTTLE_WINDOW_MS: '90000' }),
    90_000,
  );
});

test('a configured capacity is honored end to end', () => {
  reset();
  const env = { ARIES_INSIGHTS_FORCE_THROTTLE_BURST: '2' };
  assert.equal(consumeInsightsForceToken(1, 'goal', T0, env).allowed, true);
  assert.equal(consumeInsightsForceToken(1, 'goal', T0, env).allowed, true);
  assert.equal(consumeInsightsForceToken(1, 'goal', T0, env).allowed, false);
});

// ── The response a throttled caller actually receives ────────────────────────

test('the throttle response is a 429 carrying an honest, parseable cooldown', async () => {
  const res = insightsForceThrottledResponse({ allowed: false, retryAfterMs: 42_000 });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '42');

  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.equal(body.error, 'rate_limited', 'shape must match the feedback route precedent');
  assert.equal(body.retry_after_ms, 42_000);
});

test('Retry-After rounds up, so a client obeying it is never denied again immediately', () => {
  // Rounding down would tell a client to wait 1s for a 1.4s cooldown; it would
  // retry, be denied, and reasonably conclude the header is lying.
  const res = insightsForceThrottledResponse({ allowed: false, retryAfterMs: 1_400 });
  assert.equal(res.headers.get('Retry-After'), '2');

  const subsecond = insightsForceThrottledResponse({ allowed: false, retryAfterMs: 1 });
  assert.equal(subsecond.headers.get('Retry-After'), '1', 'never advertise a 0-second wait');
});

test('checkInsightsForceThrottle returns null while allowed and a 429 once drained', () => {
  reset();
  for (let i = 0; i < DEFAULT_FORCE_THROTTLE_CAPACITY; i++) {
    assert.equal(checkInsightsForceThrottle(true, 3, 'top', T0), null);
  }
  const throttled = checkInsightsForceThrottle(true, 3, 'top', T0);
  assert.ok(throttled, 'expected a response once the burst is spent');
  assert.equal(throttled?.status, 429);
});

// ── Memory ───────────────────────────────────────────────────────────────────

test('throttle state stays proportional to tenants that actually force', () => {
  reset();
  for (let tenant = 1; tenant <= 50; tenant++) {
    consumeInsightsForceToken(tenant, 'goal', T0);
  }
  assert.equal(__forceThrottleBucketCountForTests(), 50);

  // Long after everyone has refilled, a new forcing tenant triggers the sweep
  // and the stale entries go away. A refilled bucket is indistinguishable from
  // an absent one, so dropping it cannot change any decision.
  const muchLater = T0 + DEFAULT_FORCE_THROTTLE_WINDOW_MS * 10;
  for (let tenant = 1; tenant <= 50; tenant++) {
    assert.equal(consumeInsightsForceToken(tenant, 'goal', muchLater).allowed, true);
  }
  assert.ok(
    __forceThrottleBucketCountForTests() <= 50,
    'state must not grow without bound across windows',
  );
});

// ── The client half of the acceptance bar ────────────────────────────────────

test('useInsight surfaces a cooldown message rather than a bare "Server error (429)"', () => {
  // "Browser retry works" — force=true is reachable ONLY from the Retry button
  // inside <ErrorState>, so a 429 lands on a user already looking at a broken
  // panel. Telling them "Server error (429)" replaces one dead end with another.
  const source = read('frontend', 'insights', 'useInsight.ts');

  assert.match(source, /res\.status === 429/, 'the hook must special-case 429');
  assert.match(source, /Refreshing too fast/, 'the 429 needs a human-readable message');

  const throttleAt = source.indexOf('res.status === 429');
  const genericAt = source.indexOf('Server error (${res.status})');
  assert.ok(
    throttleAt !== -1 && genericAt !== -1 && throttleAt < genericAt,
    'the 429 branch must precede the generic !res.ok branch, or it is unreachable',
  );
});

test('useInsight never clears data on error, so a throttled refresh keeps the panel', () => {
  const source = read('frontend', 'insights', 'useInsight.ts');
  assert.doesNotMatch(
    source,
    /setData\(null\)/,
    'a failed or throttled refresh must not blank a populated section',
  );
});
