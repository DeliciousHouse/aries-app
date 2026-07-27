import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GET,
  handleScheduledDispatchPost,
} from '../app/api/internal/publishing/scheduled-dispatch/route';

const ROUTE_URL = 'https://aries.example.test/api/internal/publishing/scheduled-dispatch';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');

type WorkerModule = {
  dispatchOnce: (
    row: Record<string, unknown>,
    attemptToken: string,
    baseUrl: string,
    secret: string,
  ) => Promise<{ results: Array<Record<string, unknown>>; transportError: string | null }>;
  planPlatformOutcomes: (
    platforms: string[],
    results: Array<Record<string, unknown>>,
    transportError: string | null,
  ) => Array<Record<string, unknown>>;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(pathToFileURL(WORKER_PATH).href)) as unknown as WorkerModule;
}

test('scheduled-dispatch GET is an authenticated readiness probe with no provider work', async (t) => {
  const previous = process.env.INTERNAL_API_SECRET;
  try {
    await t.test('configured matching secret', async () => {
      process.env.INTERNAL_API_SECRET = 'x';
      const response = await GET(new Request(ROUTE_URL, {
        headers: { authorization: 'Bearer x' },
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready' });
    });

    await t.test('mismatched secret', async () => {
      process.env.INTERNAL_API_SECRET = 'x';
      const response = await GET(new Request(ROUTE_URL, {
        headers: { authorization: 'Bearer y' },
      }));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'invalid_internal_callback_secret' });
    });

    await t.test('app secret not configured', async () => {
      delete process.env.INTERNAL_API_SECRET;
      const response = await GET(new Request(ROUTE_URL, {
        headers: { authorization: 'Bearer z' },
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'internal_api_secret_not_configured' });
    });
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previous;
  }
});

test('missing app secret POST reaches no DB/provider work and stays retryable pre-provider in the worker', async () => {
  const previousSecret = process.env.INTERNAL_API_SECRET;
  const previousFetch = globalThis.fetch;
  let dbCalls = 0;
  let providerCalls = 0;
  let actualRouteResponse: { status: number; body: unknown } | null = null;
  const dbSpy = {
    query: async () => {
      dbCalls += 1;
      throw new Error('DB must not be reached when app auth is unusable');
    },
    connect: async () => {
      dbCalls += 1;
      throw new Error('DB ownership must not be reached when app auth is unusable');
    },
  };
  const providerSpy = async () => {
    providerCalls += 1;
    throw new Error('provider must not be reached when app auth is unusable');
  };

  try {
    delete process.env.INTERNAL_API_SECRET;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await handleScheduledDispatchPost(request, {
        db: dbSpy as never,
        dispatchPublish: providerSpy as never,
      });
      actualRouteResponse = {
        status: response.status,
        body: await response.clone().json(),
      };
      return response;
    }) as typeof fetch;

    const worker = await loadWorker();
    const dispatch = await worker.dispatchOnce({
      id: 71,
      post_id: 42,
      tenant_id: 15,
      target_platforms: ['facebook'],
      caption: 'scheduled publish auth regression',
      surface: 'feed',
      media_type: 'image',
    }, 'attempt-auth-regression', 'https://aries.example.test', 'worker-secret');

    assert.deepEqual(actualRouteResponse, {
      status: 503,
      body: { error: 'internal_api_secret_not_configured' },
    });
    assert.equal(dbCalls, 0, 'auth must fail before ownership or any other DB access');
    assert.equal(providerCalls, 0, 'auth must fail before provider dispatch');
    assert.equal(dispatch.transportError, null);
    assert.deepEqual(dispatch.results, [{
      provider: 'facebook',
      ok: false,
      error: 'internal_api_secret_not_configured',
      retryable: true,
      kind: 'pre_provider',
    }]);
    const outcomes = worker.planPlatformOutcomes(
      ['facebook'],
      dispatch.results,
      dispatch.transportError,
    );
    assert.deepEqual(outcomes, [{
      platform: 'facebook',
      status: 'pending',
      error: 'internal_api_secret_not_configured',
      retryable: true,
      platformPostId: null,
    }]);
    assert.equal(
      outcomes.some((outcome) => outcome.status === 'manual_reconciliation'),
      false,
      'a proven pre-provider auth failure must never manufacture manual-reconciliation evidence',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
  }
});
