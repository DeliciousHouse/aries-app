import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

/**
 * AA-123 (S7-5, gap D1) — client coalescing on /insights.
 *
 * Nine sections fetched eagerly and re-fired on every filter toggle with no
 * dedup and no abort, so a superseded request still ran its aggregate query
 * server-side. Three toggles cost 27 queries and used 9.
 *
 * This file is the STRUCTURAL half: it pins the wiring and the AA-152 invariant
 * that a lazy section must never gate its own MARKUP on viewport state. The
 * behavioural half — which drives the real hook against a stub fetch and proves
 * the aborting actually happens — is the sibling
 * tests/insights-client-coalescing.behaviour.test.ts. Both run together in
 * `npm run verify`.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-client-coalescing.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

const HOOK = read('frontend', 'insights', 'useInsight.ts');
const LAZY = read('frontend', 'insights', 'LazyInsightSection.tsx');
const DASHBOARD = read('frontend', 'insights', 'InsightsDashboard.tsx');

// ── Abort: the core complaint ────────────────────────────────────────────────

test('every request carries an abort signal', () => {
  // Without a signal the server finishes work nobody will read. The `tick`
  // counter alone only discarded the RESPONSE.
  assert.match(HOOK, /new AbortController\(\)/);
  assert.match(HOOK, /fetch\(url, \{ signal \}\)/, 'the signal must reach fetch');
});

test('superseding a run releases it, which aborts when nothing else holds it', () => {
  // The bug I nearly shipped: bumping `tick` in the cleanup invalidates the
  // RESULT but leaves the request running. The cleanup must release the held
  // request, and release must abort on the last reference.
  assert.match(HOOK, /const active = useRef</, 'the hook must track what it holds');
  assert.match(HOOK, /return \(\) => \{\s*\n\s*tick\.current \+= 1;\s*\n\s*releaseActive\(\);/);
  assert.match(
    HOOK,
    /entry\.refs -= 1;\s*\n\s*if \(entry\.refs > 0\) return;[\s\S]{0,160}entry\.controller\.abort\(\)/,
    'release must abort only when the last consumer lets go',
  );
});

test('an abort is never surfaced as an error to the operator', () => {
  // Otherwise every filter toggle flashes a failure state.
  assert.match(HOOK, /function isAbortError/);
  assert.match(HOOK, /if \(isAbortError\(e\)\) return;/);
});

// ── Dedup ────────────────────────────────────────────────────────────────────

test('identical concurrent requests share one in-flight fetch', () => {
  assert.match(HOOK, /const INFLIGHT = new Map<string, InflightRequest>\(\)/);
  assert.match(HOOK, /existing\.refs \+= 1;/, 'a second caller joins rather than refetching');
});

test('a forced refresh never joins an in-flight normal request', () => {
  // Piggybacking would resolve the Retry button with the very body the user is
  // trying to replace — the button would appear to do nothing.
  assert.match(HOOK, /acquireRequest\(url, !force\)/);
  assert.match(HOOK, /function acquireRequest\(url: string, dedup: boolean\)/);
  assert.match(HOOK, /if \(dedup\) \{\s*\n\s*const existing = INFLIGHT\.get\(url\)/);
});

test('the shared body is parsed once, not per consumer', () => {
  // A Response body can only be read once; deduped callers must share the
  // PARSED outcome or the second consumer gets a stream error.
  assert.match(HOOK, /interface InsightFetchOutcome/);
  assert.match(HOOK, /outcome: Promise<InsightFetchOutcome>/);
});

test('a settled request stops being shared', () => {
  // Otherwise a later mount would resolve instantly against a completed promise
  // and render stale data forever.
  assert.match(HOOK, /if \(INFLIGHT\.get\(url\) === entry\) INFLIGHT\.delete\(url\)/);
});

// ── Lazy loading, without repeating AA-152 ───────────────────────────────────

test('AA-152: the lazy wrapper always renders its children', () => {
  // The prior incident: viewport-gated CONTENT never appeared. This wrapper
  // gates the fetch only, so the section's markup is unconditional.
  assert.match(LAZY, /return <div ref=\{ref\}>\{children\(visible\)\}<\/div>;/);
  assert.doesNotMatch(
    LAZY,
    /\{visible \?\s*children|visible &&\s*children/,
    'children must never be conditional on visibility',
  );
});

test('an environment without IntersectionObserver fetches eagerly', () => {
  // Failing toward "fetch" degrades to the pre-AA-123 behaviour. Failing toward
  // "wait" would mean a permanently empty section on SSR/jsdom/old browsers.
  assert.match(LAZY, /useState\(\(\) => !canObserve\(\)\)/);
  assert.match(LAZY, /typeof window\.IntersectionObserver === "function"/);
  assert.match(LAZY, /if \(!node \|\| !canObserve\(\)\) \{[\s\S]{0,220}setVisible\(true\)/);
});

test('visibility is a one-way latch', () => {
  // Scrolling past a section and back must not re-request data it already has.
  assert.match(LAZY, /observer\.disconnect\(\);/);
  assert.match(LAZY, /if \(visible\) return;/);
});

test('the observer starts loading before the section is on screen', () => {
  assert.match(LAZY, /LAZY_SECTION_ROOT_MARGIN = "600px"/);
  assert.match(LAZY, /rootMargin: LAZY_SECTION_ROOT_MARGIN/);
});

// ── Dashboard wiring ─────────────────────────────────────────────────────────

const LAZY_SECTIONS = [
  'AttentionSection',
  'ActivitySection',
  'TrendsSection',
  'TopPostsSection',
  'ConversationsSection',
  'AriesSection',
  'AudienceSection',
];

test('every below-the-fold section is gated, and its gate is wired to enabled', () => {
  for (const section of LAZY_SECTIONS) {
    assert.match(
      DASHBOARD,
      new RegExp(`<${section}[^>]*enabled=\\{visible\\}`),
      `${section} must receive the visibility gate`,
    );
  }
  assert.equal(
    (DASHBOARD.match(/<LazyInsightSection>/g) ?? []).length,
    LAZY_SECTIONS.length,
    'one wrapper per deferred section',
  );
});

test('the above-the-fold sections stay eager', () => {
  // Hero and Goal are what the page is FOR. Deferring them would trade the
  // thing the user came to read for a request nobody was waiting on.
  assert.match(DASHBOARD, /<HeroSection period=\{period\} platform=\{platform\} \/>/);
  assert.match(DASHBOARD, /<GoalSection period=\{period\} platform=\{platform\} \/>/);
});

test('a deferred section does not claim to be loading while it waits', () => {
  // `loading` seeded from `enabled`: a section that has not been scrolled to is
  // idle, not pending, so it renders its own empty shell rather than a spinner
  // that may never resolve.
  assert.match(HOOK, /useState\(enabled\)/);
  assert.match(HOOK, /if \(!enabled\) return;/, 'a disabled hook must not fetch');
});

test('every gated section accepts the enabled prop', () => {
  for (const section of LAZY_SECTIONS) {
    const source = read('frontend', 'insights', `${section}.tsx`);
    assert.match(source, /enabled\?: boolean;/, `${section} props must declare enabled`);
    assert.match(source, /\{ enabled \}\)/, `${section} must forward it to useInsight`);
  }
});
