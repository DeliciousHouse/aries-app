/**
 * tests/insights-comment-classification.test.ts
 *
 * Unit coverage for the raw-Hermes comment classifier
 * (backend/insights/sync/classify-comments.ts). Drives it with a fake gateway —
 * no network, no DB — asserting the submit/poll/parse/normalize contract and the
 * best-effort failure reasons the sync dispatcher relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommentsWithHermes,
  isCommentClassificationEnabled,
} from '../backend/insights/sync/classify-comments';

const ENV = {
  ARIES_COMMENT_CLASSIFICATION_ENABLED: '1',
  HERMES_GATEWAY_URL: 'https://hermes.test',
  HERMES_API_SERVER_KEY: 'k',
};

const noSleep = async () => {};

// Fake gateway: POST /v1/runs → run id; GET poll → one completed envelope.
function gateway(outputEnvelope: unknown, opts: { submitStatus?: number; pollStatus?: string } = {}) {
  const captured: { body?: any } = {};
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/v1/runs') && init?.method === 'POST') {
      captured.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ run_id: 'run-1' }), { status: opts.submitStatus ?? 200 });
    }
    return new Response(
      JSON.stringify({ status: opts.pollStatus ?? 'completed', output: JSON.stringify(outputEnvelope) }),
      { status: 200 },
    );
  };
  return { fetchImpl, captured };
}

test('classifies a batch and echoes ids', async () => {
  const { fetchImpl, captured } = gateway({
    status: 'ok',
    output: [
      { id: 1, sentiment: 'positive', is_lead: false, category: 'compliment' },
      { id: 2, sentiment: 'neutral', is_lead: true, category: 'question' },
    ],
  });
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'love it' }, { id: 2, text: 'how much?' }],
    env: ENV, fetchImpl: fetchImpl as any, sleep: noSleep,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.labels.get(1)?.sentiment, 'positive');
  assert.equal(res.labels.get(1)?.isLead, false);
  assert.equal(res.labels.get(2)?.isLead, true);
  assert.equal(res.labels.get(2)?.category, 'question');
  // the prompt carries the comment ids
  assert.match(captured.body.input, /"id":1/);
});

test('normalizes casing/garbage values + coerces is_lead', async () => {
  const { fetchImpl } = gateway({
    status: 'ok',
    output: [{ id: 5, sentiment: 'NEGATIVE', is_lead: 'true', category: 'garbage' }],
  });
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 5, text: 'bad' }], env: ENV, fetchImpl: fetchImpl as any, sleep: noSleep,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.labels.get(5)?.sentiment, 'negative');
  assert.equal(res.labels.get(5)?.isLead, true);
  assert.equal(res.labels.get(5)?.category, 'other'); // unknown category → 'other'
});

test('drops labels for ids not in the input batch', async () => {
  const { fetchImpl } = gateway({
    status: 'ok',
    output: [
      { id: 1, sentiment: 'positive', is_lead: false, category: 'compliment' },
      { id: 999, sentiment: 'positive', is_lead: true, category: 'question' },
    ],
  });
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }], env: ENV, fetchImpl: fetchImpl as any, sleep: noSleep,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.labels.has(999), false);
  assert.equal(res.labels.size, 1);
});

test('gate off → disabled (no network)', async () => {
  let called = false;
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }], env: {},
    fetchImpl: (async () => { called = true; return new Response('{}'); }) as any, sleep: noSleep,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'disabled');
  assert.equal(called, false);
});

test('missing gateway config → not_configured', async () => {
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }],
    env: { ARIES_COMMENT_CLASSIFICATION_ENABLED: '1' }, sleep: noSleep,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not_configured');
});

test('failed run → run_failed (best-effort, no throw)', async () => {
  const { fetchImpl } = gateway({}, { pollStatus: 'failed' });
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }], env: ENV, fetchImpl: fetchImpl as any, sleep: noSleep,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'run_failed');
});

test('unparseable output → output_invalid', async () => {
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'r' }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'completed', output: 'not json at all' }), { status: 200 });
  };
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }], env: ENV, fetchImpl: fetchImpl as any, sleep: noSleep,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'output_invalid');
});

test('isCommentClassificationEnabled reads truthy variants', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE']) {
    assert.equal(isCommentClassificationEnabled({ ARIES_COMMENT_CLASSIFICATION_ENABLED: v }), true);
  }
  for (const v of ['', '0', 'off', 'no', undefined]) {
    assert.equal(isCommentClassificationEnabled({ ARIES_COMMENT_CLASSIFICATION_ENABLED: v }), false);
  }
});

// ── Gateway naming in unreachable details (audit item 5a) ────────────────────
// `classifyComments: unreachable (fetch failed)` was logged on every sync for
// months and named nothing. The cause was DNS: the sync sidecar had
// HERMES_GATEWAY_URL=http://host.docker.internal:8642 but not the
// `host.docker.internal:host-gateway` extra_hosts mapping, which was declared
// on aries-app only. Naming the host in the failure is what makes that
// diagnosable from a log line.

const HOST_ENV = {
  ARIES_COMMENT_CLASSIFICATION_ENABLED: '1',
  HERMES_GATEWAY_URL: 'http://host.docker.internal:8642',
  HERMES_API_SERVER_KEY: 'super-secret-key',
};

test('a submit-side unreachable names the gateway host:port', async () => {
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }],
    env: HOST_ENV,
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any,
    sleep: noSleep,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unreachable');
  assert.match(String(res.detail), /fetch failed \(gateway host\.docker\.internal:8642\)/);
});

test('a poll-side unreachable names the gateway host:port too', async () => {
  let calls = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'r' }), { status: 200 });
    }
    throw new TypeError('fetch failed');
  };
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }], env: HOST_ENV, fetchImpl: fetchImpl as any, sleep: noSleep,
  });
  assert.ok(calls >= 2);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unreachable');
  assert.match(String(res.detail), /gateway host\.docker\.internal:8642/);
});

test('no failure detail ever contains the API server key', async () => {
  const details: string[] = [];
  const cases: Array<() => Promise<unknown>> = [
    () => classifyCommentsWithHermes({
      comments: [{ id: 1, text: 'x' }], env: HOST_ENV,
      fetchImpl: (async () => { throw new Error('boom super-secret'); }) as any, sleep: noSleep,
    }),
    () => classifyCommentsWithHermes({
      comments: [{ id: 1, text: 'x' }], env: HOST_ENV,
      fetchImpl: (async () => new Response('', { status: 401 })) as any, sleep: noSleep,
    }),
  ];
  for (const run of cases) {
    const res = (await run()) as { ok: boolean; detail?: string };
    if (!res.ok && res.detail) details.push(res.detail);
  }
  assert.ok(details.length > 0, 'the cases above must produce failure details');
  for (const d of details) {
    assert.ok(!d.includes('super-secret-key'), `API key leaked into a detail: ${d}`);
  }
});

test('an unset gateway URL leaves the detail unadorned rather than saying "(gateway )"', async () => {
  // not_configured short-circuits before any fetch, so exercise the unreachable
  // path with a URL that has no parseable origin.
  const res = await classifyCommentsWithHermes({
    comments: [{ id: 1, text: 'x' }],
    env: { ...HOST_ENV, HERMES_GATEWAY_URL: 'garbage-not-a-url' },
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any,
    sleep: noSleep,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.detail, 'fetch failed');
});
