import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectProductionReviewArtifacts } from '../backend/marketing/artifact-collector';
import { createMarketingJobFacts } from '../backend/marketing/job-facts';
import { createMarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

test('collectProductionReviewArtifacts emits one video artifact per rendered variant', async () => {
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aries-video-artifacts-'));
  const runId = 'run-video-artifacts';
  const jobId = 'job-video-artifacts';

  process.env.LOBSTER_STAGE3_CACHE_DIR = tempRoot;

  try {
    const runtimeDoc = createMarketingJobRuntimeDocument({
      jobId,
      tenantId: 'tenant-video-artifacts',
      payload: {
        brandUrl: 'https://brand.example.com',
      },
      brandKit: {
        path: path.join(tempRoot, 'brand-kit.json'),
        source_url: 'https://brand.example.com',
        canonical_url: 'https://brand.example.com',
        brand_name: 'Brand Example',
        logo_urls: [],
        colors: {
          primary: '#111111',
          secondary: '#f4f4f4',
          accent: '#c24d2c',
          palette: ['#111111', '#f4f4f4', '#c24d2c'],
        },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: '2026-04-24T00:00:00.000Z',
        brand_voice_summary: 'Direct and grounded.',
        offer_summary: 'Proof-led launch audit.',
      },
    });
    runtimeDoc.stages.production.run_id = runId;

    await writeJson(path.join(tempRoot, runId, 'veo_video_generator.json'), {
      type: 'veo_video_generator',
      run_id: runId,
      video_assets: {
        platform_contracts: [
          {
            platform: 'TikTok',
            platform_slug: 'tiktok',
            platform_requirements: {
              target_duration_seconds: 20,
              aspect_ratio: '9:16',
            },
            rendered_video_variants: [
              {
                family_id: 'family-a',
                family_name: 'Family A',
                aspect_ratio: '9:16',
                duration_seconds: 20,
                video_path: `/data/generated/draft/jobs/${jobId}/videos/tiktok-family-a.mp4`,
              },
              {
                family_id: 'family-b',
                family_name: 'Family B',
                aspect_ratio: '9:16',
                duration_seconds: 20,
                video_path: `/data/generated/draft/jobs/${jobId}/videos/tiktok-family-b.mp4`,
              },
            ],
          },
          {
            platform: 'YouTube Shorts',
            platform_slug: 'youtube-shorts',
            platform_requirements: {
              target_duration_seconds: 30,
              aspect_ratio: '9:16',
            },
            rendered_video_variants: [
              {
                family_id: 'family-a',
                family_name: 'Family A',
                aspect_ratio: '9:16',
                duration_seconds: 30,
                video_path: `/data/generated/draft/jobs/${jobId}/videos/youtube-shorts-family-a.mp4`,
              },
              {
                family_id: 'family-b',
                family_name: 'Family B',
                aspect_ratio: '9:16',
                duration_seconds: 30,
                video_path: `/data/generated/draft/jobs/${jobId}/videos/youtube-shorts-family-b.mp4`,
              },
            ],
          },
        ],
      },
    });

    const capture = await collectProductionReviewArtifacts(
      createMarketingJobFacts(runtimeDoc, runId),
      { run_id: runId, job_id: jobId },
    );
    const videoArtifacts = capture.artifacts.filter(
      (artifact): artifact is Extract<(typeof capture.artifacts)[number], { type: 'video' }> =>
        'type' in artifact && artifact.type === 'video',
    );

    assert.equal(videoArtifacts.length, 4);

    const expected = new Map([
      ['video-tiktok-family-a', { platformSlug: 'tiktok', familyId: 'family-a' }],
      ['video-tiktok-family-b', { platformSlug: 'tiktok', familyId: 'family-b' }],
      ['video-youtube-shorts-family-a', { platformSlug: 'youtube-shorts', familyId: 'family-a' }],
      ['video-youtube-shorts-family-b', { platformSlug: 'youtube-shorts', familyId: 'family-b' }],
    ]);

    for (const artifact of videoArtifacts) {
      const variant = expected.get(artifact.id);
      assert.ok(variant, `unexpected video artifact id ${artifact.id}`);
      assert.equal(artifact.contentType, 'video/mp4');
      assert.equal(artifact.url, `/api/marketing/jobs/${jobId}/assets/${artifact.id}`);
      assert.equal(artifact.posterUrl, `/api/marketing/jobs/${jobId}/assets/${artifact.id}-poster`);
      assert.equal(artifact.platformSlug, variant.platformSlug);
      assert.equal(artifact.familyId, variant.familyId);
    }
  } finally {
    if (previousStage3CacheDir === undefined) delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    else process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('collectProductionReviewArtifacts skips rate-limited video variants so review can continue without broken previews', async () => {
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aries-video-rate-limited-artifacts-'));
  const runId = 'run-video-rate-limited-artifacts';
  const jobId = 'job-video-rate-limited-artifacts';

  process.env.LOBSTER_STAGE3_CACHE_DIR = tempRoot;

  try {
    const runtimeDoc = createMarketingJobRuntimeDocument({
      jobId,
      tenantId: 'tenant-video-rate-limited-artifacts',
      payload: {
        brandUrl: 'https://brand.example.com',
      },
      brandKit: {
        path: path.join(tempRoot, 'brand-kit.json'),
        source_url: 'https://brand.example.com',
        canonical_url: 'https://brand.example.com',
        brand_name: 'Brand Example',
        logo_urls: [],
        colors: {
          primary: '#111111',
          secondary: '#f4f4f4',
          accent: '#c24d2c',
          palette: ['#111111', '#f4f4f4', '#c24d2c'],
        },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: '2026-04-24T00:00:00.000Z',
        brand_voice_summary: 'Direct and grounded.',
        offer_summary: 'Proof-led launch audit.',
      },
    });
    runtimeDoc.stages.production.run_id = runId;

    await writeJson(path.join(tempRoot, runId, 'veo_video_generator.json'), {
      type: 'veo_video_generator',
      run_id: runId,
      video_assets: {
        render_status: 'partial_rate_limited',
        platform_contracts: [
          {
            platform: 'YouTube Shorts',
            platform_slug: 'youtube-shorts',
            render_status: 'rendered',
            platform_requirements: {
              target_duration_seconds: 30,
              aspect_ratio: '9:16',
            },
            rendered_video_variants: [
              {
                family_id: 'family-a',
                family_name: 'Family A',
                aspect_ratio: '9:16',
                duration_seconds: 30,
                video_path: `/data/generated/draft/jobs/${jobId}/videos/youtube-shorts-family-a.mp4`,
              },
            ],
          },
          {
            platform: 'YouTube longform',
            platform_slug: 'youtube-longform',
            render_status: 'rate_limited',
            render_failures: [{ rate_limited: true, error: 'HTTP Error 429: Too Many Requests' }],
            platform_requirements: {
              target_duration_seconds: 300,
              aspect_ratio: '16:9',
            },
            rendered_video_variants: [
              {
                family_id: 'family-a',
                family_name: 'Family A',
                aspect_ratio: '16:9',
                duration_seconds: 300,
                video_path: `/data/generated/draft/jobs/${jobId}/videos/youtube-longform-family-a.mp4`,
              },
            ],
          },
        ],
      },
    });

    const capture = await collectProductionReviewArtifacts(
      createMarketingJobFacts(runtimeDoc, runId),
      { run_id: runId, job_id: jobId },
    );
    const videoArtifacts = capture.artifacts.filter(
      (artifact): artifact is Extract<(typeof capture.artifacts)[number], { type: 'video' }> =>
        'type' in artifact && artifact.type === 'video',
    );

    assert.deepEqual(videoArtifacts.map((artifact) => artifact.id), ['video-youtube-shorts-family-a']);
  } finally {
    if (previousStage3CacheDir === undefined) delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    else process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
