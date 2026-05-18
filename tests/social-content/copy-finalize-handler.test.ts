import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  handleSocialCopyFinalizeOutput,
  SocialCopyFinalizeHandlerError,
} from '../../backend/social-content/copy-finalize-handler';
import { loadSocialCopyArtifact } from '../../backend/social-content/social-copy-store';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-social-copy-handler-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const canonicalPosts = [
  { id: 'post-1', channel: 'instagram_feed' },
  { id: 'post-2', channel: 'facebook_feed' },
] as const;

function validOutput() {
  return {
    version: '2026-05-social-copy-v1',
    generated_at: '2026-05-18T00:00:00.000Z',
    posts: [
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Instagram proof with warmth.',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
      {
        id: 'post-2',
        channel: 'facebook_feed',
        caption: 'Facebook proof with detail.',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
    ],
  };
}

test('handleSocialCopyFinalizeOutput persists a completed artifact when every post validates', async () => {
  await withRuntimeEnv(async () => {
    const result = await handleSocialCopyFinalizeOutput({
      jobId: 'job-complete',
      output: validOutput(),
      canonicalPosts: [...canonicalPosts],
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.invalidPostCount, 0);
    const stored = await loadSocialCopyArtifact('job-complete');
    assert.deepEqual(stored, result.artifact);
  });
});

test('handleSocialCopyFinalizeOutput retries exactly once and preserves already-valid posts before retry', async () => {
  await withRuntimeEnv(async () => {
    const retryCalls: Array<Record<string, unknown>> = [];
    const result = await handleSocialCopyFinalizeOutput({
      jobId: 'job-retry-once',
      output: {
        version: '2026-05-social-copy-v1',
        generated_at: '2026-05-18T00:00:00.000Z',
        posts: [
          {
            id: 'post-1',
            channel: 'instagram_feed',
            caption: 'Instagram proof with warmth.',
            hashtags: Array.from({ length: 31 }, (_, index) => `#tag${index}`),
            cta: 'Book now',
            warnings: [],
          },
          {
            id: 'post-2',
            channel: 'facebook_feed',
            caption: 'Facebook proof with detail.',
            hashtags: ['#Proof'],
            cta: 'Book now',
            warnings: [],
          },
        ],
      },
      canonicalPosts: [...canonicalPosts],
      retry: async (input) => {
        retryCalls.push({
          attempt: input.attempt,
          constraintFeedback: input.constraintFeedback,
          invalidPosts: input.invalidPosts,
        });
        return { ok: true };
      },
    });

    assert.equal(result.status, 'retry_submitted');
    assert.equal(result.invalidPostCount, 1);
    assert.equal(result.retrySubmitted, true);
    assert.equal(retryCalls.length, 1);
    assert.equal(retryCalls[0]?.attempt, 1);
    assert.match(String(retryCalls[0]?.constraintFeedback), /hashtags/i);

    const stored = await loadSocialCopyArtifact('job-retry-once');
    assert.deepEqual(stored?.posts.map((post) => post.id), ['post-2']);
  });
});

test('handleSocialCopyFinalizeOutput stores invalid retry results with validator warnings after the single retry budget is spent', async () => {
  await withRuntimeEnv(async () => {
    const result = await handleSocialCopyFinalizeOutput({
      jobId: 'job-warning-fallback',
      output: {
        version: '2026-05-social-copy-v1',
        generated_at: '2026-05-18T00:00:00.000Z',
        posts: [
          {
            id: 'post-1',
            channel: 'instagram_feed',
            caption: 'Instagram proof with warmth.',
            hashtags: Array.from({ length: 31 }, (_, index) => `#tag${index}`),
            cta: 'Book now',
            warnings: ['model_warning:too_many_tags'],
          },
          {
            id: 'post-2',
            channel: 'facebook_feed',
            caption: 'Facebook proof with detail.',
            hashtags: [],
            cta: 'Book now',
            warnings: [],
          },
        ],
      },
      canonicalPosts: [...canonicalPosts],
      attempt: 1,
    });

    assert.equal(result.status, 'completed_with_warnings');
    assert.equal(result.invalidPostCount, 1);
    assert.deepEqual(result.persisted.artifact.posts[0]?.warnings, [
      'model_warning:too_many_tags',
      'validator:too_many_hashtags',
    ]);
  });
});

test('handleSocialCopyFinalizeOutput does not submit a second retry when attempt is already non-zero', async () => {
  await withRuntimeEnv(async () => {
    let retryCalled = false;
    const result = await handleSocialCopyFinalizeOutput({
      jobId: 'job-no-second-retry',
      output: {
        version: '2026-05-social-copy-v1',
        generated_at: '2026-05-18T00:00:00.000Z',
        posts: [
          {
            id: 'post-1',
            channel: 'instagram_feed',
            caption: 'Instagram proof with warmth.',
            hashtags: Array.from({ length: 31 }, (_, index) => `#tag${index}`),
            cta: 'Book now',
            warnings: [],
          },
          {
            id: 'post-2',
            channel: 'facebook_feed',
            caption: 'Facebook proof with detail.',
            hashtags: [],
            cta: 'Book now',
            warnings: [],
          },
        ],
      },
      canonicalPosts: [...canonicalPosts],
      attempt: 1,
      retry: async () => {
        retryCalled = true;
        return { ok: true };
      },
    });

    assert.equal(result.status, 'completed_with_warnings');
    assert.equal(retryCalled, false);
  });
});

test('handleSocialCopyFinalizeOutput fails loudly on post-id mismatches', async () => {
  await withRuntimeEnv(async () => {
    await assert.rejects(
      () => handleSocialCopyFinalizeOutput({
        jobId: 'job-id-mismatch',
        output: {
          version: '2026-05-social-copy-v1',
          generated_at: '2026-05-18T00:00:00.000Z',
          posts: [
            {
              id: 'wrong-post-id',
              channel: 'instagram_feed',
              caption: 'Wrong id',
              hashtags: [],
              cta: 'Book now',
              warnings: [],
            },
          ],
        },
        canonicalPosts: [...canonicalPosts],
      }),
      (error: unknown) => error instanceof SocialCopyFinalizeHandlerError
        && error.code === 'social_copy_finalize_post_id_mismatch',
    );
  });
});

test('handleSocialCopyFinalizeOutput accepts nested result payloads from the Hermes callback bridge', async () => {
  await withRuntimeEnv(async () => {
    const result = await handleSocialCopyFinalizeOutput({
      jobId: 'job-nested-result',
      output: {
        result: validOutput(),
      },
      canonicalPosts: [...canonicalPosts],
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.artifact.posts[0]?.id, 'post-1');
  });
});
