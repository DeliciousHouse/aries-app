import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withMediaEnv<T>(run: (ctx: { dataRoot: string; hermesRoot: string }) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousHermesCacheDir = process.env.HERMES_CACHE_DIR;
  const root = await mkdtemp(path.join(tmpdir(), 'aries-social-media-ingest-'));
  const dataRoot = path.join(root, 'data-root');
  const hermesRoot = path.join(root, 'hermes-cache');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(hermesRoot, { recursive: true });

  process.env.DATA_ROOT = dataRoot;
  process.env.HERMES_CACHE_DIR = hermesRoot;
  try {
    return await run({ dataRoot, hermesRoot });
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousHermesCacheDir === undefined) delete process.env.HERMES_CACHE_DIR;
    else process.env.HERMES_CACHE_DIR = previousHermesCacheDir;
    await rm(root, { recursive: true, force: true });
  }
}

test('ingestSocialContentVideoRenderOutput copies allowed Hermes media into the job videos directory', async () => {
  await withMediaEnv(async ({ dataRoot, hermesRoot }) => {
    const { ingestSocialContentVideoRenderOutput } = await import('../backend/social-content/media-ingest');

    const jobId = 'job-video-ingest';
    const videoPath = path.join(hermesRoot, 'cache', 'videos', 'runs', 'video.mp4');
    const posterPath = path.join(hermesRoot, 'cache', 'images', 'runs', 'poster.png');
    await mkdir(path.dirname(videoPath), { recursive: true });
    await mkdir(path.dirname(posterPath), { recursive: true });
    await writeFile(videoPath, Buffer.from('fake-mp4-bytes'));
    await writeFile(posterPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const output = [{
      video_assets: {
        platform_contracts: [{
          platform_slug: 'TikTok',
          rendered_video_variants: [{
            family_id: 'Launch Cut',
            video_path: videoPath,
            thumbnail_path: posterPath,
          }],
        }],
      },
    }];

    const result = ingestSocialContentVideoRenderOutput(jobId, output);
    assert.equal(result.rewrites.length, 2);
    assert.equal(result.skipped.length, 0);

    const variant = (output[0] as any).video_assets.platform_contracts[0].rendered_video_variants[0];
    const expectedVideoPath = path.join(dataRoot, 'generated', 'draft', 'jobs', jobId, 'videos', 'tiktok-launch-cut.mp4');
    const expectedPosterPath = path.join(dataRoot, 'generated', 'draft', 'jobs', jobId, 'videos', 'tiktok-launch-cut-poster.png');

    assert.equal(variant.video_path, expectedVideoPath);
    assert.equal(variant.poster_path, expectedPosterPath);
    assert.equal(variant.thumbnail_path, expectedPosterPath);
    assert.deepEqual(await readFile(expectedVideoPath), Buffer.from('fake-mp4-bytes'));
    assert.deepEqual(await readFile(expectedPosterPath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

test('ingestSocialContentVideoRenderOutput refuses sources outside the Hermes allowlist', async () => {
  await withMediaEnv(async ({ dataRoot }) => {
    const { ingestSocialContentVideoRenderOutput } = await import('../backend/social-content/media-ingest');

    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'aries-social-media-outside-'));
    const outsideVideoPath = path.join(outsideRoot, 'outside.mp4');
    await writeFile(outsideVideoPath, Buffer.from('outside-video'));

    try {
      const output = [{
        video_assets: {
          platform_contracts: [{
            platform_slug: 'TikTok',
            rendered_video_variants: [{
              family_id: 'Unsafe',
              video_path: outsideVideoPath,
            }],
          }],
        },
      }];

      const result = ingestSocialContentVideoRenderOutput('job-video-ingest', output);
      assert.equal(result.rewrites.length, 0);
      assert.deepEqual(result.skipped, [{ path: outsideVideoPath, reason: 'not_allowed' }]);
      assert.equal((output[0] as any).video_assets.platform_contracts[0].rendered_video_variants[0].video_path, outsideVideoPath);

      const expectedVideoPath = path.join(dataRoot, 'generated', 'draft', 'jobs', 'job-video-ingest', 'videos', 'tiktok-unsafe.mp4');
      await assert.rejects(readFile(expectedVideoPath));
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('ingestSocialContentVideoRenderOutput allows already-ingested exact destination paths but rejects other DATA_ROOT media', async () => {
  await withMediaEnv(async ({ dataRoot }) => {
    const { ingestSocialContentVideoRenderOutput } = await import('../backend/social-content/media-ingest');

    const jobId = 'job-video-ingest';
    const expectedVideoPath = path.join(dataRoot, 'generated', 'draft', 'jobs', jobId, 'videos', 'tiktok-launch-cut.mp4');
    const expectedPosterPath = path.join(dataRoot, 'generated', 'draft', 'jobs', jobId, 'videos', 'tiktok-launch-cut-poster.png');
    await mkdir(path.dirname(expectedVideoPath), { recursive: true });
    await writeFile(expectedVideoPath, Buffer.from('existing-video'));
    await writeFile(expectedPosterPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const otherJobPosterPath = path.join(dataRoot, 'generated', 'draft', 'jobs', 'other-job', 'videos', 'tiktok-launch-cut-poster.png');
    await mkdir(path.dirname(otherJobPosterPath), { recursive: true });
    await writeFile(otherJobPosterPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const output = [{
      video_assets: {
        platform_contracts: [{
          platform_slug: 'TikTok',
          rendered_video_variants: [
            {
              family_id: 'Launch Cut',
              video_path: expectedVideoPath,
              thumbnail_path: expectedPosterPath,
            },
            {
              family_id: 'Unsafe Poster',
              thumbnail_path: otherJobPosterPath,
            },
          ],
        }],
      },
    }];

    const result = ingestSocialContentVideoRenderOutput(jobId, output);
    assert.equal(result.rewrites.length, 2);
    assert.deepEqual(result.skipped, [{ path: otherJobPosterPath, reason: 'not_allowed' }]);

    const variants = (output[0] as any).video_assets.platform_contracts[0].rendered_video_variants;
    assert.equal(variants[0].video_path, expectedVideoPath);
    assert.equal(variants[0].thumbnail_path, expectedPosterPath);
    assert.equal(variants[0].poster_path, expectedPosterPath);
    assert.equal(variants[1].thumbnail_path, otherJobPosterPath);
  });
});
