import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildSocialContentDashboardProjection } from '../../backend/social-content/dashboard-projection';
import { writeSocialCopyArtifact } from '../../backend/social-content/social-copy-store';
import type { MarketingDashboardAsset, MarketingDashboardPost } from '../../backend/marketing/dashboard-content';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';
import { DashboardAssetCard, DashboardPostCard } from '../../frontend/marketing/job-status';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-dashboard-copy-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

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
    tenant_id: 'tenant_social_copy_projection',
    job_id: 'mkt_social_copy_projection',
    created_at: '2026-05-17T00:00:00.000Z',
    updated_at: '2026-05-17T00:00:00.000Z',
    inputs: {
      brand_url: 'https://brand.example',
      request: {
        jobType: 'weekly_social_content',
        businessName: 'Bright Studio',
      },
    },
    brand_kit: {
      brand_name: 'Bright Studio',
    },
    social_content_runtime: {
      currentStage: 'social_copy_finalize',
      stageOrder: ['planning', 'creative_review', 'social_copy_finalize', 'publish_review'],
      stages: {
        planning: {
          output: {
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  id: 'creative-founder-story',
                  day: 'Day 1',
                  platforms: ['instagram'],
                  post_type: 'static',
                  title: 'Founder story',
                  caption: 'Planning summary that should stay compact.',
                  creative_brief_id: 'creative-founder-story',
                  status: 'approved',
                },
              ],
              image_creatives: [
                {
                  id: 'creative-founder-story',
                  title: 'Founder story image',
                  aspect_ratio: '4:5',
                  prompt: 'Warm studio portrait.',
                  status: 'generated',
                  artifact_url: '',
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

test('dashboard projection surfaces finalized copy on posts and keeps asset fields single-sourced via relatedPostIds', async () => {
  await withRuntimeEnv(async () => {
    const doc = runtimeDoc();
    await writeSocialCopyArtifact(doc.job_id, {
      version: '2026-05-social-copy-v1',
      generated_at: '2026-05-17T00:05:00.000Z',
      posts: [
        {
          id: 'creative-founder-story',
          channel: 'instagram_feed',
          caption: 'Final image-aware caption with proof.',
          hashtags: ['#Proof', '#StudioLife'],
          cta: 'Book your fitting.',
          warnings: ['29 hashtags — at IG limit'],
        },
      ],
    });

    const dashboard = buildSocialContentDashboardProjection(doc, emptyDashboard());

    assert.equal(dashboard.posts[0].summary, 'Planning summary that should stay compact.');
    assert.equal(dashboard.posts[0].caption, 'Final image-aware caption with proof.');
    assert.deepEqual(dashboard.posts[0].hashtags, ['#Proof', '#StudioLife']);
    assert.equal(dashboard.posts[0].cta, 'Book your fitting.');
    assert.deepEqual(dashboard.posts[0].copyWarnings, ['29 hashtags — at IG limit']);
    assert.equal('caption' in dashboard.assets[0], false);
    assert.deepEqual(dashboard.assets[0].relatedPostIds, [dashboard.posts[0].id]);
  });
});

test('dashboard projection falls back cleanly when no finalized social-copy artifact exists', () => {
  const dashboard = buildSocialContentDashboardProjection(runtimeDoc(), emptyDashboard());

  assert.equal(dashboard.posts[0].summary, 'Planning summary that should stay compact.');
  assert.equal(dashboard.posts[0].caption, null);
  assert.deepEqual(dashboard.posts[0].hashtags, []);
  assert.equal(dashboard.posts[0].cta, null);
  assert.deepEqual(dashboard.posts[0].copyWarnings, []);
});

test('dashboard cards render finalized copy on posts and reverse-lookup linked post copy on assets', () => {
  const post: MarketingDashboardPost = {
    id: 'post-1',
    postId: 'campaign-1',
    jobId: 'job-1',
    type: 'platform_post',
    title: 'Founder story',
    summary: 'Planning summary that should stay compact.',
    caption: 'Final image-aware caption with proof.',
    hashtags: ['#Proof', '#StudioLife'],
    cta: 'Book your fitting.',
    copyWarnings: ['29 hashtags — at IG limit'],
    platform: 'instagram',
    platformLabel: 'Instagram',
    postName: 'Bright Studio',
    funnelStage: 'weekly_content',
    objective: 'Book appointments',
    destinationUrl: 'https://brand.example',
    previewAssetId: 'asset-1',
    status: 'ready',
    createdAt: '2026-05-17T00:00:00.000Z',
    conceptId: 'asset-1',
    relatedAssetIds: ['asset-1'],
    relatedPublishItemIds: [],
    provenance: {
      sourceKind: 'creative_output',
      sourceStage: 'production',
      sourceRunId: null,
      isDerivedSchedule: false,
      isPlatformNative: false,
    },
  };

  const asset: MarketingDashboardAsset = {
    id: 'asset-1',
    postId: 'campaign-1',
    jobId: 'job-1',
    type: 'image_ad',
    title: 'Founder story image',
    summary: 'Asset summary stays unchanged.',
    platform: 'instagram',
    platformLabel: 'Instagram',
    postName: 'Bright Studio',
    funnelStage: 'weekly_content',
    objective: 'Book appointments',
    destinationUrl: 'https://brand.example',
    previewUrl: null,
    thumbnailUrl: null,
    contentType: 'image/png',
    status: 'ready',
    createdAt: '2026-05-17T00:00:00.000Z',
    relatedPostIds: ['post-1'],
    relatedPublishItemIds: [],
    provenance: {
      sourceKind: 'creative_output',
      sourceStage: 'production',
      sourceRunId: null,
      isDerivedSchedule: false,
      isPlatformNative: false,
    },
  };

  const postMarkup = renderToStaticMarkup(
    React.createElement(DashboardPostCard, {
      post,
      previewAsset: asset,
    }),
  );
  assert.match(postMarkup, /Final image-aware caption with proof\./);
  assert.match(postMarkup, /#Proof/);
  assert.match(postMarkup, /Book your fitting\./);

  const assetMarkup = renderToStaticMarkup(
    React.createElement(DashboardAssetCard, {
      asset,
      relatedPost: post,
    }),
  );
  assert.match(assetMarkup, /Final image-aware caption with proof\./);
  assert.match(assetMarkup, /#StudioLife/);
});

test('dashboard asset card degrades cleanly when no related post is found', () => {
  const asset: MarketingDashboardAsset = {
    id: 'asset-2',
    postId: 'campaign-1',
    jobId: 'job-1',
    type: 'image_ad',
    title: 'Founder story image',
    summary: 'Asset summary stays unchanged.',
    platform: 'instagram',
    platformLabel: 'Instagram',
    postName: 'Bright Studio',
    funnelStage: 'weekly_content',
    objective: 'Book appointments',
    destinationUrl: 'https://brand.example',
    previewUrl: null,
    thumbnailUrl: null,
    contentType: 'image/png',
    status: 'ready',
    createdAt: '2026-05-17T00:00:00.000Z',
    relatedPostIds: [],
    relatedPublishItemIds: [],
    provenance: {
      sourceKind: 'creative_output',
      sourceStage: 'production',
      sourceRunId: null,
      isDerivedSchedule: false,
      isPlatformNative: false,
    },
  };

  const markup = renderToStaticMarkup(
    React.createElement(DashboardAssetCard, {
      asset,
      relatedPost: null,
    }),
  );

  assert.doesNotMatch(markup, /Final image-aware caption with proof\./);
  assert.doesNotMatch(markup, /#Proof/);
});
