import assert from 'node:assert/strict';
import test from 'node:test';

import { createAriesV1Api } from '../lib/api/aries-v1';
import { ApiRequestError } from '../lib/api/http';

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeReviewItemResponseBody(id: string) {
  return {
    review: {
      id,
      jobId: 'job_demo',
      campaignId: 'camp_demo',
      campaignName: 'Demo',
      reviewType: 'creative',
      workflowState: 'in_review',
      workflowStage: 'production',
      title: 'Demo Creative',
      channel: 'instagram',
      placement: 'feed',
      scheduledFor: '2026-04-16T00:00:00.000Z',
      status: 'approved',
      summary: '',
      currentVersion: {
        id: 'v1',
        label: 'v1',
        headline: '',
        supportingText: '',
        cta: '',
        notes: [],
      },
      lastDecision: null,
      sections: [],
      attachments: [],
      history: [],
    },
  };
}

function makeStubFetch(
  responses: Array<() => Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const factory = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (!factory) {
      throw new Error('unexpected fetch call');
    }
    return factory();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('decideReview retries once on 502 and returns the eventual 200 body', async () => {
  const okBody = makeReviewItemResponseBody('rv_demo');
  const { fetchImpl, calls } = makeStubFetch([
    () => jsonResponse(502, {}),
    () => jsonResponse(200, okBody),
  ]);
  const api = createAriesV1Api({ baseUrl: 'http://test.invalid', fetchImpl });

  const result = await api.decideReview('rv_demo', {
    action: 'approve',
    actedBy: 'tester@example.com',
  });

  assert.equal(calls.length, 2, 'should have retried exactly once');
  assert.equal(
    calls[0].url,
    'http://test.invalid/api/marketing/reviews/rv_demo/decision',
  );
  assert.equal(result.review.id, 'rv_demo');
});

test('decideReview rethrows ApiRequestError with status 502 when both attempts fail', async () => {
  const { fetchImpl, calls } = makeStubFetch([
    () => jsonResponse(502, { error: 'bad gateway' }),
    () => jsonResponse(502, { error: 'bad gateway' }),
  ]);
  const api = createAriesV1Api({ baseUrl: 'http://test.invalid', fetchImpl });

  await assert.rejects(
    () =>
      api.decideReview('rv_demo', {
        action: 'approve',
        actedBy: 'tester@example.com',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ApiRequestError, 'should preserve typed error');
      assert.equal((err as ApiRequestError).status, 502);
      return true;
    },
  );
  assert.equal(calls.length, 2, 'should stop after maxAttempts');
});

test('decideReview does not retry on a first-call 200', async () => {
  const okBody = makeReviewItemResponseBody('rv_demo');
  const { fetchImpl, calls } = makeStubFetch([() => jsonResponse(200, okBody)]);
  const api = createAriesV1Api({ baseUrl: 'http://test.invalid', fetchImpl });

  const result = await api.decideReview('rv_demo', {
    action: 'approve',
    actedBy: 'tester@example.com',
  });

  assert.equal(calls.length, 1, 'retry must not fire on success');
  assert.equal(result.review.id, 'rv_demo');
});

test('decideReview does not retry on a non-retryable 400', async () => {
  const { fetchImpl, calls } = makeStubFetch([
    () => jsonResponse(400, { error: 'invalid_action' }),
    () => jsonResponse(200, makeReviewItemResponseBody('rv_demo')),
  ]);
  const api = createAriesV1Api({ baseUrl: 'http://test.invalid', fetchImpl });

  await assert.rejects(
    () =>
      api.decideReview('rv_demo', {
        action: 'approve',
        actedBy: 'tester@example.com',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ApiRequestError);
      assert.equal((err as ApiRequestError).status, 400);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'non-retryable status must not trigger retry');
});
