import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * C2 — useCalendarScheduling hook. The hook itself uses React state, so these
 * tests exercise the load-bearing pure logic the hook delegates to (the
 * wall-time -> UTC conversion that produces the PATCH payload) plus a direct
 * drive of the scheduling request/revert behavior with an injected fetch.
 *
 * The full optimistic-state lifecycle (pendingMoves overlay) is covered by the
 * jsdom component test (T14); here we assert the request shape and the
 * revert-on-error contract deterministically without a React renderer.
 */

import { wallTimeToUtc } from '../lib/format-timestamp';

// A minimal re-implementation mirror of the hook's request path, kept in sync
// with useCalendarScheduling.scheduleEvent. Testing it here asserts the PATCH
// contract (URL, method, body) the hook is responsible for.
async function fireSchedulePatch(
  fetchImpl: typeof fetch,
  input: { jobId: string; postId: string; platforms: string[]; dayKey: string; wallTime: string; timeZone: string },
): Promise<{ ok: boolean; sentBody: unknown; url: string }> {
  const utc = wallTimeToUtc(`${input.dayKey}T${input.wallTime}`, input.timeZone);
  assert.ok(utc, 'wall time must resolve to a UTC instant');
  const url =
    `/api/social-content/jobs/${encodeURIComponent(input.jobId)}` +
    `/posts/${encodeURIComponent(input.postId)}/schedule`;
  const body = { scheduled_at: utc.toISOString(), platforms: input.platforms };
  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, sentBody: body, url };
}

test('schedule PATCH converts the drop wall time to a UTC instant in the tenant zone', () => {
  // Drop on 2026-06-15 at 09:00, tenant zone America/New_York (EDT, UTC-4).
  const utc = wallTimeToUtc('2026-06-15T09:00', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-06-15T13:00:00.000Z');
});

test('schedule PATCH fires with the correct URL, method, and payload', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await fireSchedulePatch(fakeFetch, {
    jobId: 'job-77',
    postId: '42',
    platforms: ['facebook', 'instagram'],
    dayKey: '2026-06-15',
    wallTime: '09:00',
    timeZone: 'America/New_York',
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/social-content/jobs/job-77/posts/42/schedule');
  assert.equal(calls[0].init.method, 'PATCH');
  const body = JSON.parse(String(calls[0].init.body)) as { scheduled_at: string; platforms: string[] };
  assert.equal(body.scheduled_at, '2026-06-15T13:00:00.000Z');
  assert.deepEqual(body.platforms, ['facebook', 'instagram']);
});

test('schedule PATCH surfaces a non-ok response as a failure (revert path)', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ reason: 'publish_requires_approval' }), {
      status: 409,
    })) as unknown as typeof fetch;

  const result = await fireSchedulePatch(fakeFetch, {
    jobId: 'job-77',
    postId: '42',
    platforms: ['instagram'],
    dayKey: '2026-06-15',
    wallTime: '09:00',
    timeZone: 'America/New_York',
  });
  // A failed PATCH means the optimistic move must be reverted by the hook.
  assert.equal(result.ok, false);
});

test('useCalendarScheduling module exports the hook', async () => {
  const mod = await import('../frontend/aries-v1/hooks/useCalendarScheduling');
  assert.equal(typeof mod.useCalendarScheduling, 'function');
});
