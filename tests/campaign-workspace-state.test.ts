import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalStepToView,
  deriveGenerationProgressState,
  deriveGateFallbackState,
  derivePublishSurfaceState,
  deriveWorkspaceHeaderState,
} from '../frontend/aries-v1/campaign-workspace-state';

function emptyDashboard() {
  return {
    campaign: null,
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

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'mkt_123',
    tenantName: 'Tenant Name',
    brandWebsiteUrl: null,
    campaignBrief: null,
    reviewBundle: null,
    dashboard: emptyDashboard(),
    approval: null,
    workflowState: 'draft',
    stageCards: [],
    nextStep: 'wait_for_completion',
    plannedPostCount: null,
    createdPostCount: null,
    brandReview: null,
    strategyReview: null,
    creativeReview: null,
    publishConfig: {
      platforms: [],
      livePublishPlatforms: [],
      videoRenderPlatforms: [],
    },
    ...overrides,
  };
}

test('approvalStepToView maps workflow checkpoints to campaign gates', () => {
  assert.equal(approvalStepToView('approve_stage_2'), 'brand');
  assert.equal(approvalStepToView('approve_stage_3'), 'strategy');
  assert.equal(approvalStepToView('approve_stage_4'), 'creative');
  assert.equal(approvalStepToView('approve_stage_4_publish'), 'publish');
  assert.equal(approvalStepToView('unknown'), null);
});

test('deriveGateFallbackState links the active gate to the approval review route when the checkpoint matches', () => {
  const fallback = deriveGateFallbackState(
    makeStatus({
      approval: {
        workflowStepId: 'approve_stage_2',
        title: 'Research complete',
        message: 'Research is complete. Continue to brand analysis.',
        actionLabel: 'Continue to brand analysis',
        actionHref: '/review/mkt_123%3A%3Aapproval',
      },
      nextStep: 'submit_approval',
    }) as any,
    'brand',
    'mkt_123',
  );

  assert.equal(fallback.title, 'Research complete');
  assert.equal(fallback.action?.label, 'Continue to brand analysis');
  assert.equal(fallback.action?.href, '/review/mkt_123%3A%3Aapproval');
});

test('deriveGateFallbackState routes downstream gates back to the blocking review gate', () => {
  const fallback = deriveGateFallbackState(
    makeStatus({
      workflowState: 'strategy_review_required',
    }) as any,
    'publish',
    'mkt_123',
  );

  assert.equal(fallback.title, 'Strategy Review is blocking this gate');
  assert.equal(fallback.action?.label, 'Open Strategy Review');
  assert.equal(fallback.action?.href, '/dashboard/campaigns/mkt_123?view=strategy');
});

test('deriveGateFallbackState does not block creative when a stale strategy gate is already approved', () => {
  const fallback = deriveGateFallbackState(
    makeStatus({
      workflowState: 'strategy_review_required',
      approval: {
        workflowStepId: 'approve_stage_3',
        title: 'Strategy approval is ready',
        message: 'Approve strategy before creative.',
        actionLabel: 'Approve strategy',
        actionHref: '/review/mkt_123%3A%3Astrategy',
      },
      strategyReview: {
        reviewId: 'mkt_123::strategy-review',
        reviewType: 'strategy',
        status: 'approved',
        title: 'Strategy Review',
        summary: 'Strategy is approved.',
        notePlaceholder: 'Add a note',
        sections: [],
        attachments: [],
        history: [],
        latestNote: null,
      },
    }) as any,
    'creative',
    'mkt_123',
  );

  assert.notEqual(fallback.title, 'Strategy Review is blocking this gate');
  assert.equal(fallback.action, null);
});

test('deriveGateFallbackState sends revisions_requested traffic to the review queue', () => {
  const fallback = deriveGateFallbackState(
    makeStatus({
      workflowState: 'revisions_requested',
    }) as any,
    'creative',
    'mkt_123',
    'Requested changes must be resolved before this gate can continue.',
  );

  assert.equal(fallback.action?.href, '/review');
  assert.equal(fallback.description, 'Requested changes must be resolved before this gate can continue.');
});

test('derivePublishSurfaceState prefers blocked and approval-pending copy before ready copy', () => {
  const blocked = derivePublishSurfaceState(
    makeStatus({
      workflowState: 'creative_review_required',
      dashboard: emptyDashboard(),
    }) as any,
    'mkt_123',
    'Every required creative asset must be approved before publish can be unlocked.',
  );
  assert.equal(blocked.title, 'Launch is blocked');
  assert.equal(blocked.description, 'Every required creative asset must be approved before publish can be unlocked.');

  const pendingApproval = derivePublishSurfaceState(
    makeStatus({
      approval: {
        workflowStepId: 'approve_stage_4_publish',
        title: 'Publish approval is ready',
        message: 'The final publish checkpoint is ready for review.',
        actionLabel: 'Open publish approval',
        actionHref: '/review/mkt_123%3A%3Aapproval',
      },
      dashboard: emptyDashboard(),
    }) as any,
    'mkt_123',
  );
  assert.equal(pendingApproval.action?.href, '/review/mkt_123%3A%3Aapproval');
  assert.equal(pendingApproval.emptyTitle, 'Publish queue opens after approval');
});

test('derivePublishSurfaceState only shows publish-ready copy when launch items exist', () => {
  const ready = derivePublishSurfaceState(
    makeStatus({
      workflowState: 'ready_to_publish',
      dashboard: {
        ...emptyDashboard(),
        publishItems: [
          {
            id: 'pub_1',
            title: 'Meta launch package',
            summary: 'Ready to go',
            status: 'ready_to_publish',
            platformLabel: 'Meta Ads',
            destinationUrl: null,
          },
        ],
      },
    }) as any,
    'mkt_123',
  );
  assert.equal(ready.title, 'Launch-ready items are available');

  const waiting = derivePublishSurfaceState(
    makeStatus({
      workflowState: 'ready_to_publish',
      dashboard: emptyDashboard(),
    }) as any,
    'mkt_123',
  );
  assert.equal(waiting.title, 'Launch preparation is still running');
});

test('deriveGenerationProgressState maps creative asset progress from production contract counts', () => {
  const progress = deriveGenerationProgressState(
    makeStatus({
      workflowState: 'creative_review_required',
      stageCards: [
        {
          stage: 'production',
          label: 'Production',
          status: 'running',
          summary: 'Creative outputs are in production.',
          highlight: 'Static contracts: 3, Video contracts: 1',
        },
      ],
      dashboard: {
        ...emptyDashboard(),
        campaign: {
          counts: {
            imageAds: 1,
          },
        },
        assets: [
          {
            id: 'asset_1',
            type: 'image_ad',
            title: 'Meta image',
            platform: 'meta-ads',
            contentType: 'image/png',
            previewUrl: '/materials/assets/meta-image.png',
            thumbnailUrl: null,
          },
        ],
      },
    }) as any,
  );

  assert.equal(progress?.totalCount, 4);
  assert.equal(progress?.completedCount, 1);
  assert.equal(progress?.activeCount, 2);
  assert.equal(progress?.currentLabel, 'Generating asset 2 of 4');
  assert.equal(progress?.imageCount, 3);
  assert.equal(progress?.videoCount, 1);
});



test('deriveGenerationProgressState does not count creative assets as ready until previews exist', () => {
  const progress = deriveGenerationProgressState(
    makeStatus({
      workflowState: 'creative_review_required',
      stageCards: [
        {
          stage: 'production',
          label: 'Production',
          status: 'running',
          summary: 'Creative outputs are in production.',
          highlight: 'Static contracts: 2',
        },
      ],
      dashboard: {
        ...emptyDashboard(),
        campaign: {
          counts: {
            imageAds: 2,
          },
        },
        assets: [
          {
            id: 'asset_pending',
            type: 'image_ad',
            title: 'Pending Meta image',
            platform: 'meta-ads',
            contentType: 'image/png',
            previewUrl: null,
            thumbnailUrl: null,
          },
        ],
      },
      creativeReview: {
        assets: [
          {
            reviewId: 'review_pending',
            assetId: 'asset_pending',
            title: 'Pending Meta image',
            platformLabel: 'Meta Ads',
            contentType: 'image/png',
            previewUrl: null,
            fullPreviewUrl: null,
          },
        ],
      },
    }) as any,
  );

  assert.equal(progress?.totalCount, 2);
  assert.equal(progress?.completedCount, 0);
  assert.equal(progress?.currentLabel, 'Generating image 1 of 2');
  assert.equal(progress?.isComplete, false);
});

test('deriveGenerationProgressState falls back to planned and created counts when contract counts are missing', () => {
  const progress = deriveGenerationProgressState(
    makeStatus({
      workflowState: 'creative_review_required',
      plannedPostCount: 4,
      createdPostCount: 1,
    }) as any,
  );

  assert.equal(progress?.totalCount, 4);
  assert.equal(progress?.completedCount, 1);
  assert.equal(progress?.currentLabel, 'Generating item 2 of 4');
});

test('deriveGenerationProgressState stays hidden before creative production becomes relevant', () => {
  const progress = deriveGenerationProgressState(
    makeStatus({
      workflowState: 'draft',
      plannedPostCount: 4,
      createdPostCount: 1,
    }) as any,
  );

  assert.equal(progress, null);
});

test('deriveWorkspaceHeaderState prefers the source domain over contaminated dashboard campaign names', () => {
  const header = deriveWorkspaceHeaderState(
    makeStatus({
      brandWebsiteUrl: 'https://www.glossier.com/',
      campaignBrief: {
        websiteUrl: 'https://www.glossier.com/',
      },
      dashboard: {
        ...emptyDashboard(),
        campaign: {
          name: 'frameX',
        },
      },
      tenantName: 'frameX',
    }) as any,
  );

  assert.equal(header.title, 'glossier.com');
  assert.equal(header.sourceDomain, 'glossier.com');
  assert.equal(header.sourceUrl, 'https://www.glossier.com/');
});

test('deriveWorkspaceHeaderState rejects synthetic stage-slug review campaign names and falls back', () => {
  // Regression for a historic lobster/bin/campaign-planner bug that emitted
  // f"{brand_slug}-stage2-plan" as the campaign name, which leaked into
  // reviewBundle.campaignName and won the fallback chain because it is the
  // highest-priority slot. Frontend now rejects anything matching
  // /-stage\d+-plan$/i before using it as the header title.
  const numericSlugHeader = deriveWorkspaceHeaderState(
    makeStatus({
      brandWebsiteUrl: 'https://linear.app/',
      reviewBundle: {
        campaignName: '7-stage2-plan',
      },
      tenantName: 'Linear',
    }) as any,
  );
  assert.equal(numericSlugHeader.title, 'linear.app');

  const slugifiedSlugHeader = deriveWorkspaceHeaderState(
    makeStatus({
      brandWebsiteUrl: 'https://linear.app/',
      reviewBundle: {
        campaignName: 'linear-app-stage2-plan',
      },
      tenantName: 'Linear',
    }) as any,
  );
  assert.equal(slugifiedSlugHeader.title, 'linear.app');

  const stage3SlugHeader = deriveWorkspaceHeaderState(
    makeStatus({
      brandWebsiteUrl: 'https://linear.app/',
      reviewBundle: {
        campaignName: 'linear-app-stage3-plan',
      },
      tenantName: 'Linear',
    }) as any,
  );
  assert.equal(stage3SlugHeader.title, 'linear.app');

  // A non-synthetic campaign name should still win.
  const realNameHeader = deriveWorkspaceHeaderState(
    makeStatus({
      brandWebsiteUrl: 'https://linear.app/',
      reviewBundle: {
        campaignName: 'Linear Growth Testing Plan',
      },
      tenantName: 'Linear',
    }) as any,
  );
  assert.equal(realNameHeader.title, 'Linear Growth Testing Plan');
});
