/**
 * Reel-publish fix #2 — regression cover for the terminal no-video-asset
 * dispatch outcome (shipped in #841, previously untested).
 *
 * A video post with no ingested video asset can never publish. The dispatch
 * route must fail it TERMINALLY (retryable:false) instead of letting the media
 * validator reject it retryably on every worker tick until campaign end (the
 * posts 415/416 manual-defuse incident, 2026-07-13), and the worker must map
 * that outcome onto a terminal 'failed' child row.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com INTERNAL_API_SECRET=test-secret \
 *     ./node_modules/.bin/tsx --test tests/reel-dispatch-terminal-no-video.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { POST } from '../app/api/internal/publishing/scheduled-dispatch/route';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type WorkerModule = {
  planPlatformOutcomes: (
    platforms: string[],
    results: Array<{ provider: string; ok: boolean; error?: string; retryable?: boolean }>,
    transportError: string | null,
    mediaType?: string,
  ) => Array<{ platform: string; status: string; error: string | null; retryable: boolean }>;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts', 'automations', 'scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerModule;
}

function makeDispatchRequest(body: Record<string, unknown>): Request {
  return new Request('https://aries.example.com/api/internal/publishing/scheduled-dispatch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

test('dispatch route: video post with no media fails TERMINALLY per platform (422, retryable:false)', async () => {
  const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'test-secret';
  try {
    // No media_urls and no post_id => rawMediaUrls stays empty with no DB
    // lookup, hitting the no-video-asset guard directly.
    const res = await POST(
      makeDispatchRequest({
        tenant_id: '15',
        post_id: '',
        platforms: ['instagram', 'facebook'],
        content: 'reel caption',
        surface: 'reel',
        media_type: 'video',
        media_urls: [],
      }),
    );

    assert.equal(res.status, 422, 'terminal-failure status');
    const body = (await res.json()) as {
      status: string;
      results: Array<{ provider: string; ok: boolean; error?: string; retryable?: boolean; kind?: string }>;
    };
    assert.equal(body.status, 'error');
    assert.equal(body.results.length, 2, 'one result per requested platform');
    for (const result of body.results) {
      assert.equal(result.ok, false);
      assert.equal(result.retryable, false, `${result.provider} must be non-retryable`);
      assert.equal(result.kind, 'permanent');
      assert.match(result.error ?? '', /no_video_asset/);
    }
  } finally {
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
  }
});

test('worker: the no_video_asset outcome maps to a terminal failed child row (never re-claimed)', async () => {
  const { planPlatformOutcomes } = await loadWorker();
  const outcomes = planPlatformOutcomes(
    ['instagram', 'facebook'],
    [
      { provider: 'instagram', ok: false, error: 'no_video_asset: video post has no ingested video creative to publish', retryable: false },
      { provider: 'facebook', ok: false, error: 'no_video_asset: video post has no ingested video creative to publish', retryable: false },
    ],
    null,
    'video',
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'failed', `${outcome.platform} child row must be terminal`);
    assert.equal(outcome.retryable, false);
  }
});
