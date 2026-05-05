import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeWeeklySocialContentPayload } from '@/backend/social-content/payload';
import { buildSocialContentWeeklyRequest } from '@/backend/social-content/workflow-request';
import type { SocialContentCalendarEvent } from '@/backend/marketing/jobs-status';
import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';
import { calendarConsoleCopyForMode } from '@/frontend/app-shell/calendar-console';
import {
  dashboardConsoleCopyForMode,
  dashboardWeeklyCreativeReadyCount,
} from '@/frontend/app-shell/dashboard-console';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-social-content-weekly-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => stringValues(entry));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => stringValues(entry));
  }
  return [];
}

test('weekly payload defaults campaign window to 7 days', () => {
  const normalized = normalizeWeeklySocialContentPayload({});
  assert.equal(normalized.campaignWindowDays, 7);
  assert.equal(normalized.windowDays, 7);
});

test('weekly payload clamps campaign window to 1-14 days', () => {
  const low = normalizeWeeklySocialContentPayload({ campaignWindowDays: 0 });
  const high = normalizeWeeklySocialContentPayload({ campaignWindowDays: 30 });
  assert.equal(low.campaignWindowDays, 1);
  assert.equal(high.campaignWindowDays, 14);
});

test('weekly payload caps image/video generation counts', () => {
  const normalized = normalizeWeeklySocialContentPayload({
    imageCreativeCount: 99,
    videoRenderCount: 99,
  });
  assert.equal(normalized.imageCreativeCount, 2);
  assert.equal(normalized.videoRenderCount, 1);
});

test('weekly payload redacts token-like primitive strings without dropping references', () => {
  const normalized = normalizeWeeklySocialContentPayload({
    primaryGoal: 'sk-primaryGoalSecret123',
    offer: 'access_token=offerSecret123',
    notes: 'Use bearer Bearer notesSecret123 for setup',
    creativeBriefs: [
      'Hero concept api_key=creativeSecret123',
      'Launch ordinary weekly content',
    ],
    visualReferences: [
      'https://assets.example/image.png?access_token=visualSecret123&width=1024',
      'refresh_token=visualReferenceSecret123',
    ],
    nested: {
      connection_id: 'conn_reference_is_not_secret',
      userId: 'user-reference-is-not-secret',
    },
  });
  const serialized = JSON.stringify(normalized);

  for (const secret of [
    'sk-primaryGoalSecret123',
    'offerSecret123',
    'notesSecret123',
    'creativeSecret123',
    'visualSecret123',
    'visualReferenceSecret123',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('Launch ordinary weekly content'), true);
  assert.equal(serialized.includes('conn_reference_is_not_secret'), true);
  assert.equal(serialized.includes('user-reference-is-not-secret'), true);
});

test('weekly workflow request uses default scope counts/channels', () => {
  const doc = {
    tenant_id: 'tenant_default',
    job_id: 'mkt_default',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: 'https://competitor.example',
      competitor_brand: 'Competitor',
      facebook_page_url: '',
      ad_library_url: '',
      request: {},
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_default',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(request.workflow_key, 'social_content_weekly');
  assert.equal(request.workflow_version, '2026-05-social-content-weekly-v1');
  assert.equal(request.input.scope.window_days, 7);
  assert.equal(request.input.scope.static_post_count, 3);
  assert.equal(request.input.scope.image_creative_count, 2);
  assert.equal(request.input.scope.video_script_count, 1);
  assert.equal(request.input.scope.video_render_count, 0);
  assert.deepEqual(request.input.scope.channels, ['meta', 'instagram']);
});

test('weekly workflow request forwards normalized forbidden visual patterns', () => {
  const doc = {
    tenant_id: 'tenant_patterns',
    job_id: 'mkt_patterns',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: '',
      competitor_brand: '',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        forbiddenVisualPatterns: ['no split-screen', 'no fake UI screenshot'],
      },
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_patterns',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(request.input.constraints.forbidden_visual_patterns, [
    'no split-screen',
    'no fake UI screenshot',
  ]);
});

test('weekly workflow request uses normalized window and strips token query params', () => {
  const doc = {
    tenant_id: 'tenant_123',
    job_id: 'mkt_123',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: 'https://competitor.example',
      competitor_brand: 'Competitor',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        campaignWindowDays: 10,
        visualReferences: [
          'https://assets.example/image.png?access_token=secret123&width=1024',
          'https://assets.example/video.mp4?token=abc',
        ],
      },
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_test',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(request.input.scope.window_days, 10);
  assert.deepEqual(request.input.brand.visual_references, [
    'https://assets.example/image.png?width=1024',
    'https://assets.example/video.mp4',
  ]);
});

test('weekly job status defaults to a 7-day calendar and keeps events in range', async () => {
  await withRuntimeEnv(async () => {
    const {
      createMarketingJobRuntimeDocument,
      saveMarketingJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_weekly_default',
      tenantId: 'tenant_weekly_default',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
      },
      brandKit: {
        path: '/tmp/brand-kit.json',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Brand',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });
    saveMarketingJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    const weeklyEvents = status.calendarEvents.filter(
      (event): event is SocialContentCalendarEvent =>
        typeof event === 'object' && event !== null && 'dayIndex' in event,
    );

    assert.equal(status.durationDays, 7);
    assert.equal(status.plannedPostCount, 4);
    assert.equal(weeklyEvents.length, status.calendarEvents.length);
    assert.equal(weeklyEvents.every((event) => event.dayIndex >= 1 && event.dayIndex <= 7), true);
    assert.equal(dashboardWeeklyCreativeReadyCount(weeklyEvents), 0);
  });
});

test('weekly job status planned count equals requested static + script/render items', async () => {
  await withRuntimeEnv(async () => {
    const {
      createMarketingJobRuntimeDocument,
      saveMarketingJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_weekly_counts',
      tenantId: 'tenant_weekly_counts',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
        campaignWindowDays: 7,
        staticPostCount: 5,
        videoScriptCount: 2,
        videoRenderCount: 1,
      },
      brandKit: {
        path: '/tmp/brand-kit.json',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Brand',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });
    saveMarketingJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    assert.equal(status.plannedPostCount, 8);
  });
});

test('social-content status response rewrites 30-day approval copy to weekly language', async () => {
  await withRuntimeEnv(async () => {
    const {
      createMarketingJobRuntimeDocument,
      saveMarketingJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { handleGetMarketingJobStatus } = await import('@/app/api/marketing/jobs/[jobId]/handler');

    const doc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_weekly_copy',
      tenantId: 'tenant_weekly_copy',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
      },
      brandKit: {
        path: '/tmp/brand-kit.json',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Brand',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });
    doc.state = 'approval_required';
    doc.status = 'awaiting_approval';
    doc.current_stage = 'strategy';
    doc.stages.research.status = 'completed';
    doc.stages.strategy.status = 'awaiting_approval';
    doc.approvals.current = {
      stage: 'strategy',
      status: 'awaiting_approval',
      approval_id: 'mkta_weekly_copy',
      workflow_step_id: 'approve_stage_3',
      resume_token: null,
      title: 'Stage 3 creative and the 30-day launch calendar are ready.',
      message: 'Stage 3 creative and the 30-day launch calendar are ready.',
      requested_at: new Date().toISOString(),
    };
    saveMarketingJobRuntime(doc.job_id, doc);

    const response = await handleGetMarketingJobStatus(
      doc.job_id,
      async () => ({
        userId: 'user_weekly_copy',
        tenantId: doc.tenant_id,
        tenantSlug: 'tenant-weekly-copy',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );
    const body = await response.json();

    assert.match((body as { summary: { subheadline: string } }).summary.subheadline, /7-day content calendar/i);
    assert.doesNotMatch((body as { approval: { message: string } }).approval.message, /30-day/i);
    const values = stringValues(body).join('\n');
    assert.doesNotMatch(values, /Campaign accepted/i);
    assert.doesNotMatch(values, /Campaign strategy is ready/i);
    assert.doesNotMatch(values, /Launch review previews/i);
    assert.doesNotMatch(values, /Launch review and publishing/i);
  });
});

test('weekly dashboard and calendar UI copy uses content-plan labels', () => {
  const copy = [
    ...Object.values(dashboardConsoleCopyForMode(true, 7)),
    ...Object.values(calendarConsoleCopyForMode(true, 7)),
  ].join('\n');

  for (const expected of [
    'Weekly content plan',
    'Posts planned',
    'Creatives ready',
    'Video script ready',
    '7-day content calendar',
  ]) {
    assert.match(copy, new RegExp(expected, 'i'));
  }

  assert.doesNotMatch(copy, /Campaign window/i);
  assert.doesNotMatch(copy, /Launch campaign/i);
});

test('weekly dashboard counts backend-vetted image-creative IDs as ready', () => {
  const event: SocialContentCalendarEvent = {
    id: 'social-static-1',
    jobId: 'mkt_weekly_real_creative',
    dayIndex: 1,
    startsAt: '2026-05-05T00:00:00.000Z',
    endsAt: null,
    platform: 'instagram',
    platformLabel: 'Instagram',
    title: 'Weekly social post 1',
    postType: 'static',
    status: 'needs_review',
    assetPreviewId: 'image-creative-1',
  };

  assert.equal(dashboardWeeklyCreativeReadyCount([event]), 1);
});

test('custom weekly window copy uses the actual duration label', async () => {
  const uiCopy = [
    ...Object.values(dashboardConsoleCopyForMode(true, 10)),
    ...Object.values(calendarConsoleCopyForMode(true, 10)),
  ].join('\n');

  assert.match(uiCopy, /10-day content calendar/i);
  assert.doesNotMatch(uiCopy, /7-day content calendar/i);

  await withRuntimeEnv(async () => {
    const {
      createMarketingJobRuntimeDocument,
      saveMarketingJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { handleGetMarketingJobStatus } = await import('@/app/api/marketing/jobs/[jobId]/handler');

    const doc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_weekly_10_day_copy',
      tenantId: 'tenant_weekly_10_day_copy',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
        campaignWindowDays: 10,
      },
      brandKit: {
        path: '/tmp/brand-kit.json',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Brand',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });
    saveMarketingJobRuntime(doc.job_id, doc);

    const response = await handleGetMarketingJobStatus(
      doc.job_id,
      async () => ({
        userId: 'user_weekly_10_day_copy',
        tenantId: doc.tenant_id,
        tenantSlug: 'tenant-weekly-10-day-copy',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );
    const body = await response.json();
    const subheadline = (body as { summary: { subheadline: string } }).summary.subheadline;

    assert.match(subheadline, /10-day content calendar/i);
    assert.doesNotMatch(subheadline, /7-day content calendar/i);
  });
});

test('weekly needs-connection status points operators to Hermes media setup', async () => {
  await withRuntimeEnv(async () => {
    const {
      createMarketingJobRuntimeDocument,
      saveMarketingJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { handleGetMarketingJobStatus } = await import('@/app/api/marketing/jobs/[jobId]/handler');

    const doc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_weekly_needs_connection',
      tenantId: 'tenant_weekly_needs_connection',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
      },
      brandKit: {
        path: '/tmp/brand-kit.json',
        source_url: 'https://brand.example',
        canonical_url: 'https://brand.example',
        brand_name: 'Brand',
        logo_urls: [],
        colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });
    doc.state = 'needs_connection';
    doc.status = 'needs_connection';
    doc.current_stage = 'research';
    doc.last_error = {
      code: 'hermes_media_setup_required',
      message: 'Hermes media configuration needs attention before weekly media generation can continue.',
      stage: 'research',
      retryable: true,
      at: new Date().toISOString(),
      details: { reason: 'hermes_media_setup_required' },
    };
    saveMarketingJobRuntime(doc.job_id, doc);

    const response = await handleGetMarketingJobStatus(
      doc.job_id,
      async () => ({
        userId: 'user_weekly_needs_connection',
        tenantId: doc.tenant_id,
        tenantSlug: 'tenant-weekly-needs-connection',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );
    const body = (await response.json()) as {
      nextStep?: string;
      summary?: { headline?: string; subheadline?: string };
    };

    assert.equal(body.nextStep, 'check_hermes_media_setup');
    assert.equal(body.summary?.headline, 'Hermes media setup needs attention');
    assert.match(body.summary?.subheadline ?? '', /Hermes media configuration needs attention/i);
  });
});

test('weekly workflow request includes abstract Hermes-owned media requests', () => {
  const doc = {
    tenant_id: 'tenant_media',
    job_id: 'mkt_media',
    created_by: 'user_media',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: 'https://competitor.example',
      competitor_brand: 'Competitor',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        primaryGoal: 'Get more demo requests',
        imageCreativeCount: 9,
        videoRenderCount: 5,
        openaiConnectionId: 'conn_openai_media',
        openaiAccessToken: 'sk-live-should-never-leak',
      },
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_media',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal('media_provider' in request, false);
  assert.equal(request.input.scope.image_creative_count, 2);
  assert.equal(request.input.scope.video_render_count, 1);
  assert.deepEqual(request.input.media_requests, [
    {
      type: 'image.generate',
      aspect_ratio: '4:5',
      count: 2,
      target_channels: ['meta', 'instagram'],
      creative_briefs: ['Get more demo requests'],
    },
    {
      type: 'video.generate',
      aspect_ratio: '9:16',
      count: 1,
      requires_human_approval: true,
      script_id: 'weekly_primary',
    },
  ]);
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes('conn_openai_media'), false);
  assert.equal(serialized.includes('sk-live-should-never-leak'), false);
  assert.equal(/gemini|nano banana|lobster/i.test(serialized), false);
});

test('weekly workflow request filters image target channels to Hermes social channels', () => {
  const doc = {
    tenant_id: 'tenant_channels',
    job_id: 'mkt_channels',
    created_by: 'user_channels',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: '',
      competitor_brand: '',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        channels: ['instagram', 'meta-ads', 'landing-page'],
      },
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_channels',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(request.input.media_requests?.[0], {
    type: 'image.generate',
    aspect_ratio: '4:5',
    count: 2,
    target_channels: ['instagram'],
    creative_briefs: ['Create on-brand weekly social image creative.'],
  });
});

test('weekly workflow request redacts token-like text and media values', () => {
  const doc = {
    tenant_id: 'tenant_token_text',
    job_id: 'mkt_token_text',
    created_by: 'user_token_text',
    inputs: {
      brand_url: 'https://brand.example',
      competitor_url: 'https://competitor.example',
      competitor_brand: 'Competitor',
      facebook_page_url: '',
      ad_library_url: '',
      request: {
        primaryGoal: 'sk-primaryGoalWorkflowSecret123',
        offer: 'client_secret=offerWorkflowSecret123',
        notes: 'access_token=notesWorkflowSecret123',
        imageCreativeCount: 2,
        openaiConnectionId: 'conn_openai_token_text',
        creativeBriefs: [
          'Image prompt Bearer creativeWorkflowSecret123',
          'Safe ordinary brief',
        ],
        visualReferences: [
          'https://assets.example/image.png?api_key=visualWorkflowSecret123&width=1024',
          'id_token=visualReferenceWorkflowSecret123',
        ],
      },
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as MarketingJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_token_text',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });
  const serialized = JSON.stringify(request);

  for (const secret of [
    'sk-primaryGoalWorkflowSecret123',
    'offerWorkflowSecret123',
    'notesWorkflowSecret123',
    'creativeWorkflowSecret123',
    'visualWorkflowSecret123',
    'visualReferenceWorkflowSecret123',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('Safe ordinary brief'), true);
  assert.deepEqual(request.input.brand.visual_references, [
    'https://assets.example/image.png?width=1024',
    'id_token=[redacted]',
  ]);
});
