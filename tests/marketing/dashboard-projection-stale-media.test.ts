import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSocialContentDashboardProjection } from '../../backend/social-content/dashboard-projection';
import { __resetHermesMediaPresenceCacheForTests } from '../../backend/marketing/hermes-media-presence';
import type { MarketingDashboardAsset } from '../../backend/marketing/dashboard-content';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// qa-defect #599: the ready-to-publish inventory rendered preview `<img src>` of
// `/api/internal/hermes/media/<basename>` for creatives whose Hermes-cache bytes
// had been evicted → 404 broken thumbnails. The projection must now fall back to
// the placeholder data-URI when the media file is absent from the mount.

const HERMES_BASENAME = 'openai_codex_gpt-image-2-medium_20260519_evicted.png';
const ARTIFACT_URL = `https://aries.sugarandleather.com/api/internal/hermes/media/${HERMES_BASENAME}`;

function emptyDashboard() {
  return {
    post: null,
    posts: [],
    assets: [],
    publishItems: [],
    calendarEvents: [],
    statuses: {
      countsByStatus: {
        draft: 0,
        in_review: 0,
        ready: 0,
        ready_to_publish: 0,
        published_to_meta_paused: 0,
        scheduled: 0,
        live: 0,
      },
    },
  };
}

function runtimeDoc(): SocialContentJobRuntimeDocument {
  return {
    tenant_id: 'tenant_stale_media',
    job_id: 'mkt_stale_media',
    created_at: '2026-05-19T00:00:00.000Z',
    updated_at: '2026-05-19T00:00:00.000Z',
    inputs: { brand_url: 'https://brand.example' },
    brand_kit: { brand_name: 'Bright Studio' },
    social_content_runtime: {
      currentStage: 'creative_review',
      stageOrder: ['planning', 'creative_review', 'publish_review'],
      stages: {
        planning: {
          output: {
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  id: 'creative-1',
                  day: 'Day 1',
                  platforms: ['instagram'],
                  post_type: 'static',
                  title: 'Founder story',
                  caption: 'Caption.',
                  creative_brief_id: 'creative-1',
                  status: 'approved',
                },
              ],
              image_creatives: [
                {
                  id: 'creative-1',
                  title: 'Founder story image',
                  aspect_ratio: '4:5',
                  prompt: 'Warm studio portrait.',
                  status: 'generated',
                  artifact_url: ARTIFACT_URL,
                },
              ],
              video_scripts: [],
            },
          },
        },
      },
      publishingRequested: true,
    },
  } as unknown as SocialContentJobRuntimeDocument;
}

function imageAsset(): MarketingDashboardAsset {
  const dashboard = buildSocialContentDashboardProjection(runtimeDoc(), emptyDashboard());
  const asset = dashboard.assets.find((a) => a.type === 'image_ad');
  assert.ok(asset, 'expected an image_ad asset in the projection');
  return asset;
}

async function withMount<T>(seedBasename: string | null, run: () => Promise<T>): Promise<T> {
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const prevDataRoot = process.env.DATA_ROOT;
  const mount = await mkdtemp(path.join(tmpdir(), 'aries-stale-media-mount-'));
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-stale-media-data-'));
  if (seedBasename) {
    await writeFile(path.join(mount, seedBasename), 'png-bytes');
  }
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  process.env.DATA_ROOT = dataRoot;
  __resetHermesMediaPresenceCacheForTests();
  try {
    return await run();
  } finally {
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    __resetHermesMediaPresenceCacheForTests();
    await rm(mount, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('#599: image preview falls back to the placeholder data-URI when the Hermes media file is evicted', async () => {
  await withMount(null, async () => {
    const asset = imageAsset();
    assert.ok(
      asset.previewUrl?.startsWith('data:'),
      `expected a placeholder data-URI preview, got: ${asset.previewUrl}`,
    );
    // thumbnailUrl mirrors previewUrl, so it must not reference the dead media either.
    assert.equal(asset.thumbnailUrl, asset.previewUrl);
    assert.ok(!asset.previewUrl?.includes('/api/internal/hermes/media/'));
    // contentType is derived from previewUrl; the placeholder is an SVG data-URI.
    assert.equal(asset.contentType, 'image/svg+xml');
  });
});

test('#599: image preview keeps the Hermes media URL when the file is present on the mount', async () => {
  await withMount(HERMES_BASENAME, async () => {
    const asset = imageAsset();
    assert.equal(asset.previewUrl, ARTIFACT_URL);
    assert.equal(asset.thumbnailUrl, ARTIFACT_URL);
  });
});

test('#599: image preview is byte-identical (passes the live URL) when the mount is unconfigured', async () => {
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const prevDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-stale-media-data-'));
  delete process.env.HERMES_IMAGE_CACHE_MOUNT;
  process.env.DATA_ROOT = dataRoot;
  __resetHermesMediaPresenceCacheForTests();
  try {
    const asset = imageAsset();
    assert.equal(asset.previewUrl, ARTIFACT_URL);
  } finally {
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    __resetHermesMediaPresenceCacheForTests();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
