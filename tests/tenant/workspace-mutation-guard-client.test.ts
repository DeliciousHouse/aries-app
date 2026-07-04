/**
 * Multi-workspace mutation guard — CLIENT half (plan Decision 2a, Phase 3).
 *
 * The browser API client (lib/api/http.ts) pins the tab's booted workspace id
 * via the x-aries-workspace-id header on STATE-CHANGING requests only, never on
 * GET reads and never on the switch endpoint itself, and routes every
 * `409 workspace_mismatch` response into the single shell-level interlock. This
 * file is the failing-before/passing-after proof for that wire behavior — it is
 * fully hermetic (a fake `fetchImpl`, no DB, no request scope) because the
 * client guard (lib/api/workspace-guard.ts) is browser-safe by construction.
 *
 * Companion server-half coverage lives in
 * tests/tenant/workspace-mutation-guard-http.test.ts (the 409 mapping) and the
 * switch domain function in tests/tenant/workspace-switch.test.ts.
 */
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { requestJson } from '../../lib/api/http';
import {
  WORKSPACE_ID_HEADER,
  activateWorkspaceGuard,
  isStateChangingMethod,
  isWorkspaceGuardActive,
  getBootedWorkspaceId,
  readWorkspaceMismatchBody,
  registerWorkspaceMismatchHandler,
  reportWorkspaceMismatch,
  __resetWorkspaceGuardForTests,
} from '../../lib/api/workspace-guard';
import { WORKSPACE_ID_HEADER as SERVER_WORKSPACE_ID_HEADER } from '../../lib/tenant-context';

type Captured = { url: string; method: string; headers: Headers };

/**
 * A fake fetch that records the request and returns a canned JSON response.
 * `requestJson` never reaches the network — the client guard runs against a
 * fully in-process transport.
 */
function fakeFetch(
  status: number,
  body: unknown,
  captured: Captured[],
): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    captured.push({
      url: String(url),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: new Headers(init.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetWorkspaceGuardForTests();
});
afterEach(() => {
  __resetWorkspaceGuardForTests();
});

// ── Header name parity (client re-declares it, must never drift) ─────────────

test('client WORKSPACE_ID_HEADER matches the server header name (parity)', () => {
  assert.equal(WORKSPACE_ID_HEADER, 'x-aries-workspace-id');
  assert.equal(
    WORKSPACE_ID_HEADER,
    SERVER_WORKSPACE_ID_HEADER,
    'the client-side header value must equal lib/tenant-context.ts WORKSPACE_ID_HEADER',
  );
});

// ── Method classification ────────────────────────────────────────────────────

test('isStateChangingMethod: only POST/PUT/PATCH/DELETE are guarded writes', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
    assert.equal(isStateChangingMethod(m), true, `${m} must be a state-changing method`);
  }
  for (const m of ['GET', 'HEAD', 'OPTIONS', undefined]) {
    assert.equal(isStateChangingMethod(m), false, `${String(m)} must NOT be a state-changing method`);
  }
});

// ── activate / set-once semantics ────────────────────────────────────────────

test('activateWorkspaceGuard is set-once — a sibling repoint cannot move the pin', () => {
  activateWorkspaceGuard('7');
  assert.equal(isWorkspaceGuardActive(), true);
  assert.equal(getBootedWorkspaceId(), '7');
  // A second activation (e.g. a re-render or a sibling-tab switch) must NOT move
  // the pinned id — the whole point is that THIS tab keeps sending the id it
  // booted under so the server can detect staleness.
  activateWorkspaceGuard('9');
  assert.equal(getBootedWorkspaceId(), '7', 'pin must survive a later activation with a different id');
});

test('activateWorkspaceGuard ignores empty/null ids (never arms with a blank pin)', () => {
  activateWorkspaceGuard(null);
  activateWorkspaceGuard('');
  activateWorkspaceGuard('   ');
  assert.equal(isWorkspaceGuardActive(), false, 'blank ids must not arm the guard');
  assert.equal(getBootedWorkspaceId(), null);
});

// ── Header attachment on the wire (the core guard behavior) ──────────────────

test('guard ARMED: a mutating POST attaches the pinned workspace header', async () => {
  activateWorkspaceGuard('7');
  const captured: Captured[] = [];
  await requestJson('/api/tenant/profiles', { method: 'POST', body: JSON.stringify({}) }, {
    fetchImpl: fakeFetch(200, { status: 'ok' }, captured),
  });
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0].headers.get(WORKSPACE_ID_HEADER),
    '7',
    'a state-changing request must carry the pinned workspace id',
  );
});

test('guard ARMED: a GET read never carries the workspace header (reads may be one render stale)', async () => {
  activateWorkspaceGuard('7');
  const captured: Captured[] = [];
  await requestJson('/api/marketing/posts', { method: 'GET' }, {
    fetchImpl: fakeFetch(200, { status: 'ok' }, captured),
  });
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0].headers.get(WORKSPACE_ID_HEADER),
    null,
    'GET must NOT carry the mutation-guard header',
  );
});

test('guard ARMED: PUT/PATCH/DELETE all carry the header; the switch endpoint never does', async () => {
  activateWorkspaceGuard('7');
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const captured: Captured[] = [];
    await requestJson(`/api/business/profile`, { method, body: JSON.stringify({}) }, {
      fetchImpl: fakeFetch(200, { status: 'ok' }, captured),
    });
    assert.equal(
      captured[0].headers.get(WORKSPACE_ID_HEADER),
      '7',
      `${method} must carry the pinned workspace id`,
    );
  }

  // The switch endpoint must NEVER carry the header: the tab is pinned to the
  // OLD workspace by definition, so a header would 409 the very switch it is
  // performing (plan Decision 2a). Even routed through requestJson.
  const switchCaptured: Captured[] = [];
  await requestJson('/api/tenant/workspace/switch', { method: 'POST', body: JSON.stringify({ organizationId: '9' }) }, {
    fetchImpl: fakeFetch(200, { status: 'ok' }, switchCaptured),
  });
  assert.equal(
    switchCaptured[0].headers.get(WORKSPACE_ID_HEADER),
    null,
    'the switch endpoint must NOT carry the mutation-guard header',
  );
});

test('guard NOT ARMED (flag OFF / single-workspace tab): no header attached, byte-identical wire', async () => {
  // No activateWorkspaceGuard() call → guard inert (this is the flag-OFF and the
  // single-workspace flag-ON state; the shell only arms it for >1 membership).
  const captured: Captured[] = [];
  await requestJson('/api/tenant/profiles', { method: 'POST', body: JSON.stringify({}) }, {
    fetchImpl: fakeFetch(200, { status: 'ok' }, captured),
  });
  assert.equal(
    captured[0].headers.get(WORKSPACE_ID_HEADER),
    null,
    'an un-armed guard must attach nothing (flag OFF byte-identity)',
  );
});

test('guard ARMED: a caller-supplied workspace header is not overwritten', async () => {
  activateWorkspaceGuard('7');
  const captured: Captured[] = [];
  await requestJson(
    '/api/tenant/profiles',
    { method: 'POST', body: JSON.stringify({}), headers: { [WORKSPACE_ID_HEADER]: '99' } },
    { fetchImpl: fakeFetch(200, { status: 'ok' }, captured) },
  );
  assert.equal(captured[0].headers.get(WORKSPACE_ID_HEADER), '99');
});

// ── 409 → interlock routing (the trigger half) ───────────────────────────────

test('readWorkspaceMismatchBody: parses the shared 409 shape, rejects other 409 bodies', () => {
  const parsed = readWorkspaceMismatchBody({
    code: 'workspace_mismatch',
    active_workspace_id: '9',
    requested_workspace_id: '7',
    message: 'not performed',
  });
  assert.deepEqual(parsed, {
    activeWorkspaceId: '9',
    requestedWorkspaceId: '7',
    message: 'not performed',
  });

  // reason-keyed variant is also accepted (both the wrapper + raw route bodies).
  assert.ok(readWorkspaceMismatchBody({ reason: 'workspace_mismatch' }));

  // A non-mismatch 409 body must NOT be treated as a mismatch (e.g. last_admin).
  assert.equal(readWorkspaceMismatchBody({ code: 'last_admin' }), null);
  assert.equal(readWorkspaceMismatchBody({ error: 'conflict' }), null);
  assert.equal(readWorkspaceMismatchBody(null), null);
  assert.equal(readWorkspaceMismatchBody('nope'), null);
});

test('requestJson routes a 409 workspace_mismatch into the registered interlock handler', async () => {
  activateWorkspaceGuard('7');
  const raised: unknown[] = [];
  const unregister = registerWorkspaceMismatchHandler((payload) => raised.push(payload));

  await assert.rejects(
    () =>
      requestJson(
        '/api/tenant/profiles',
        { method: 'POST', body: JSON.stringify({}) },
        {
          fetchImpl: fakeFetch(
            409,
            {
              status: 'error',
              reason: 'workspace_mismatch',
              code: 'workspace_mismatch',
              active_workspace_id: '9',
              requested_workspace_id: '7',
              message: 'Your action was not performed.',
            },
            [],
          ),
        },
      ),
    /workspace|not performed/i,
  );

  assert.equal(raised.length, 1, 'a 409 workspace_mismatch must fire the interlock exactly once');
  assert.deepEqual(raised[0], {
    activeWorkspaceId: '9',
    requestedWorkspaceId: '7',
    message: 'Your action was not performed.',
  });
  unregister();
});

test('requestJson does NOT route a non-mismatch 409 (e.g. last_admin) into the interlock', async () => {
  activateWorkspaceGuard('7');
  const raised: unknown[] = [];
  const unregister = registerWorkspaceMismatchHandler((payload) => raised.push(payload));

  await assert.rejects(() =>
    requestJson(
      '/api/tenant/profiles/5',
      { method: 'DELETE' },
      { fetchImpl: fakeFetch(409, { error: 'last_admin' }, []) },
    ),
  );

  assert.equal(raised.length, 0, 'only workspace_mismatch 409s belong to the interlock');
  unregister();
});

test('reportWorkspaceMismatch is a no-op when no interlock is mounted (never throws)', () => {
  __resetWorkspaceGuardForTests();
  assert.doesNotThrow(() =>
    reportWorkspaceMismatch({ activeWorkspaceId: '9', requestedWorkspaceId: '7' }),
  );
});
