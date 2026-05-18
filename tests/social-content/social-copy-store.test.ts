import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadSocialCopyArtifact,
  socialCopyArtifactPath,
  SocialCopyArtifactStoreError,
  writeSocialCopyArtifact,
} from '../../backend/social-content/social-copy-store';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-social-copy-store-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function artifact(posts: Array<{ id: string; channel: string; caption: string; hashtags: string[]; cta: string; warnings: string[] }>) {
  return {
    version: '2026-05-social-copy-v1',
    generated_at: '2026-05-18T00:00:00.000Z',
    posts,
  };
}

test('loadSocialCopyArtifact returns null when the artifact file is missing', async () => {
  await withRuntimeEnv(async () => {
    const result = await loadSocialCopyArtifact('job-missing');
    assert.equal(result, null);
  });
});

test('writeSocialCopyArtifact writes canonical JSON and loadSocialCopyArtifact reads it back', async () => {
  await withRuntimeEnv(async () => {
    const result = await writeSocialCopyArtifact('job-roundtrip', artifact([
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Round-trip proof',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
    ]));

    const onDisk = await readFile(result.filePath, 'utf8');
    assert.match(onDisk, /"version": "2026-05-social-copy-v1"/);
    assert.ok(onDisk.endsWith('\n'));
    assert.deepEqual(await loadSocialCopyArtifact('job-roundtrip'), result.artifact);
  });
});

test('writeSocialCopyArtifact preserves already-completed posts during partial retries by default', async () => {
  await withRuntimeEnv(async () => {
    await writeSocialCopyArtifact('job-merge', artifact([
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Completed post',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
      {
        id: 'post-2',
        channel: 'facebook_feed',
        caption: 'Second post',
        hashtags: [],
        cta: 'Read more',
        warnings: [],
      },
    ]));

    const result = await writeSocialCopyArtifact('job-merge', artifact([
      {
        id: 'post-2',
        channel: 'facebook_feed',
        caption: 'Second post revised',
        hashtags: ['#Revised'],
        cta: 'Read more',
        warnings: ['validator:caption_too_long'],
      },
    ]));

    assert.deepEqual(result.artifact.posts.map((post) => post.id), ['post-1', 'post-2']);
    assert.equal(result.artifact.posts[0]?.caption, 'Completed post');
    assert.equal(result.artifact.posts[1]?.caption, 'Second post revised');
  });
});

test('writeSocialCopyArtifact can disable merge preservation when a full replacement is intended', async () => {
  await withRuntimeEnv(async () => {
    await writeSocialCopyArtifact('job-replace', artifact([
      {
        id: 'post-1',
        channel: 'instagram_feed',
        caption: 'Completed post',
        hashtags: ['#Proof'],
        cta: 'Book now',
        warnings: [],
      },
    ]));

    const result = await writeSocialCopyArtifact(
      'job-replace',
      artifact([
        {
          id: 'post-2',
          channel: 'facebook_feed',
          caption: 'Replacement post',
          hashtags: [],
          cta: 'Read more',
          warnings: [],
        },
      ]),
      { preserveExistingPosts: false },
    );

    assert.deepEqual(result.artifact.posts.map((post) => post.id), ['post-2']);
  });
});

test('loadSocialCopyArtifact throws a precise invalid-json code for malformed artifact files', async () => {
  await withRuntimeEnv(async () => {
    const filePath = socialCopyArtifactPath('job-invalid-json');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{not-json', 'utf8');

    await assert.rejects(
      () => loadSocialCopyArtifact('job-invalid-json'),
      (error: unknown) => error instanceof SocialCopyArtifactStoreError
        && error.code === 'social_copy_artifact_invalid_json',
    );
  });
});

test('loadSocialCopyArtifact throws a precise invalid-shape code for malformed artifact payloads', async () => {
  await withRuntimeEnv(async () => {
    const filePath = socialCopyArtifactPath('job-invalid-shape');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ version: 'v1', generated_at: '2026-05-18T00:00:00.000Z', posts: [{ id: 'post-1' }] }), 'utf8');

    await assert.rejects(
      () => loadSocialCopyArtifact('job-invalid-shape'),
      (error: unknown) => error instanceof SocialCopyArtifactStoreError
        && error.code === 'social_copy_artifact_invalid_shape',
    );
  });
});
