import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSocialContentDashboardProjection } from '@/backend/social-content/dashboard-projection';
import { parseSocialContentWorkflowOutput, socialContentArtifactsFromProjection } from '@/backend/social-content/runtime-state';
import { normalizeWeeklySocialContentPayload } from '@/backend/social-content/payload';
import { buildSocialContentWeeklyRequest } from '@/backend/social-content/workflow-request';
import type { SocialContentCalendarEvent } from '@/backend/marketing/jobs-status';
import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';
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
  assert.equal(normalized.postWindowDays, 7);
  assert.equal(normalized.windowDays, 7);
});

test('weekly payload clamps campaign window to 1-14 days', () => {
  const low = normalizeWeeklySocialContentPayload({ postWindowDays: 0 });
  const high = normalizeWeeklySocialContentPayload({ postWindowDays: 30 });
  assert.equal(low.postWindowDays, 1);
  assert.equal(high.postWindowDays, 14);
});

test('weekly payload caps image/video generation counts', () => {
  const normalized = normalizeWeeklySocialContentPayload({
    imageCreativeCount: 99,
    videoRenderCount: 99,
  });
  assert.equal(normalized.imageCreativeCount, 6);
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
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_default',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(request.workflow_key, 'social_content_weekly');
  assert.equal(request.workflow_version, '2026-05-social-content-weekly-v2');
  assert.equal(request.input.scope.window_days, 7);
  assert.equal(request.input.scope.static_post_count, 7);
  assert.equal(request.input.scope.image_creative_count, 6);
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
  } as unknown as SocialContentJobRuntimeDocument;

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
        postWindowDays: 10,
        visualReferences: [
          'https://assets.example/image.png?access_token=secret123&width=1024',
          'https://assets.example/video.mp4?token=abc',
        ],
      },
    },
    brand_kit: {
      brand_name: 'Brand Name',
    },
  } as unknown as SocialContentJobRuntimeDocument;

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
      createSocialContentJobRuntimeDocument,
      saveSocialContentJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = createSocialContentJobRuntimeDocument({
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
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    const weeklyEvents = status.calendarEvents.filter(
      (event): event is SocialContentCalendarEvent =>
        typeof event === 'object' && event !== null && 'dayIndex' in event,
    );

    assert.equal(status.durationDays, 7);
    assert.equal(status.plannedPostCount, 8);
    assert.equal(weeklyEvents.length, status.calendarEvents.length);
    assert.equal(weeklyEvents.every((event) => event.dayIndex >= 1 && event.dayIndex <= 7), true);
    assert.equal(dashboardWeeklyCreativeReadyCount(weeklyEvents), 0);
  });
});

test('createSocialContentJobRuntimeDocument derives job_type from payload.jobType', async () => {
  await withRuntimeEnv(async () => {
    const { createSocialContentJobRuntimeDocument } = await import('@/backend/marketing/runtime-state');

    const brandKit = {
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
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    };

    const weekly = createSocialContentJobRuntimeDocument({
      jobId: 'mkt_jobtype_weekly',
      tenantId: 'tenant_jobtype',
      payload: { jobType: 'weekly_social_content', brandUrl: 'https://brand.example' },
      brandKit,
    });
    assert.equal(weekly.job_type, 'weekly_social_content');

    // Absent jobType falls back to weekly_social_content.
    const fallback = createSocialContentJobRuntimeDocument({
      jobId: 'mkt_jobtype_absent',
      tenantId: 'tenant_jobtype',
      payload: { brandUrl: 'https://brand.example' },
      brandKit,
    });
    assert.equal(fallback.job_type, 'weekly_social_content');
  });
});

test('weekly job status planned count equals requested static + script/render items', async () => {
  await withRuntimeEnv(async () => {
    const {
      createSocialContentJobRuntimeDocument,
      saveSocialContentJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = createSocialContentJobRuntimeDocument({
      jobId: 'mkt_weekly_counts',
      tenantId: 'tenant_weekly_counts',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
        postWindowDays: 7,
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
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    assert.equal(status.plannedPostCount, 8);
  });
});

test('social-content status response rewrites 30-day approval copy to weekly language', async () => {
  await withRuntimeEnv(async () => {
    const {
      createSocialContentJobRuntimeDocument,
      saveSocialContentJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { handleGetMarketingJobStatus } = await import('@/app/api/marketing/jobs/[jobId]/handler');

    const doc = createSocialContentJobRuntimeDocument({
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
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
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
    saveSocialContentJobRuntime(doc.job_id, doc);

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
      createSocialContentJobRuntimeDocument,
      saveSocialContentJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { handleGetMarketingJobStatus } = await import('@/app/api/marketing/jobs/[jobId]/handler');

    const doc = createSocialContentJobRuntimeDocument({
      jobId: 'mkt_weekly_10_day_copy',
      tenantId: 'tenant_weekly_10_day_copy',
      payload: {
        jobType: 'weekly_social_content',
        brandUrl: 'https://brand.example',
        businessType: 'local service',
        primaryGoal: 'Book appointments',
        postWindowDays: 10,
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
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

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
      createSocialContentJobRuntimeDocument,
      saveSocialContentJobRuntime,
    } = await import('@/backend/marketing/runtime-state');
    const { handleGetMarketingJobStatus } = await import('@/app/api/marketing/jobs/[jobId]/handler');

    const doc = createSocialContentJobRuntimeDocument({
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
        positioning: null,
        audience: null,
        tone_of_voice: null,
        style_vibe: null,
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
    saveSocialContentJobRuntime(doc.job_id, doc);

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
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_media',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal('media_provider' in request, false);
  assert.equal(request.input.scope.image_creative_count, 6);
  assert.equal(request.input.scope.video_render_count, 1);
  assert.deepEqual(request.input.media_requests, [
    {
      type: 'image.generate',
      aspect_ratio: '4:5',
      count: 6,
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
  } as unknown as SocialContentJobRuntimeDocument;

  const request = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'arun_channels',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(request.input.media_requests?.[0], {
    type: 'image.generate',
    aspect_ratio: '4:5',
    count: 6,
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
  } as unknown as SocialContentJobRuntimeDocument;

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

test('social content dashboard projection shows unique tenant-safe image previews linked to posts and publish queue', () => {
  const doc = {
    tenant_id: 'tenant_dashboard_projection',
    job_id: 'mkt_dashboard_projection',
    created_at: '2026-05-06T00:00:00.000Z',
    updated_at: '2026-05-06T00:00:00.000Z',
    inputs: {
      brand_url: 'https://brand.example',
      request: {
        jobType: 'weekly_social_content',
        businessName: 'Bright Studio',
        primaryGoal: 'Book discovery calls',
        openaiAccessToken: 'sk-dashboard-secret-should-not-leak',
      },
    },
    brand_kit: {
      brand_name: 'Bright Studio',
      colors: {
        primary: '#14213d',
        secondary: '#fca311',
        accent: '#e5e5e5',
        palette: ['#14213d', '#fca311', '#e5e5e5'],
      },
    },
    social_content_runtime: {
      stageOrder: ['planning', 'creative_review', 'publish_review'],
      stages: {
        planning: {
          output: {
            summary: 'Weekly plan ready.',
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  day: 'Day 1',
                  platforms: ['instagram'],
                  post_type: 'static',
                  title: 'Founder story',
                  caption: 'Show the workshop ritual.',
                  creative_brief_id: 'image-founder-story',
                  status: 'approved',
                },
                {
                  day: 'Day 4',
                  platforms: ['meta'],
                  post_type: 'static',
                  title: 'Proof carousel',
                  caption: 'Share outcome proof.',
                  creative_brief_id: 'image-proof-carousel',
                  status: 'approved',
                },
              ],
              image_creatives: [
                {
                  id: 'image-founder-story',
                  title: 'Workshop ritual still life',
                  aspect_ratio: '4:5',
                  prompt: 'Close-up of leather tools on warm bench, client initials embossed, no generic office.',
                  status: 'generated',
                  artifact_url: '',
                },
                {
                  id: 'image-proof-carousel',
                  title: 'Client proof wall',
                  aspect_ratio: '4:5',
                  prompt: 'Editorial wall of handwritten customer notes and product detail, no fake UI screenshot.',
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

  const dashboard = buildSocialContentDashboardProjection(doc, {
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
  });

  assert.equal(dashboard.assets.length, 2);
  assert.equal(dashboard.posts.length, 2);
  assert.equal(dashboard.publishItems.length, 2);
  assert.equal(dashboard.posts[0].previewAssetId, 'image-founder-story');
  assert.equal(dashboard.publishItems[0].previewAssetId, 'image-founder-story');
  assert.equal(dashboard.assets.every((asset) => asset.contentType === 'image/svg+xml'), true);
  assert.equal(dashboard.statuses.countsByStatus.ready, 2);
  assert.equal(dashboard.statuses.countsByStatus.ready_to_publish, 2);
  assert.equal(dashboard.statuses.countsByStatus.in_review, 0);
  assert.equal(dashboard.assets.every((asset) => asset.previewUrl?.startsWith('data:image/svg+xml;base64,')), true);
  assert.notEqual(dashboard.assets[0].previewUrl, dashboard.assets[1].previewUrl);
  const serialized = JSON.stringify(dashboard);
  assert.equal(serialized.includes('tenant_dashboard_projection'), false);
  assert.equal(serialized.includes('sk-dashboard-secret-should-not-leak'), false);
  assert.equal(/generic ai|ai-generated|stock office/i.test(serialized), false);
});

test('social content dashboard projection keeps rich weekly output when a later stage only reports the window', () => {
  const doc = {
    tenant_id: 'tenant_dashboard_partial_stage',
    job_id: 'mkt_dashboard_partial_stage',
    created_at: '2026-05-06T00:00:00.000Z',
    updated_at: '2026-05-06T00:00:00.000Z',
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
      stageOrder: ['planning', 'video_script', 'publish_review'],
      stages: {
        planning: {
          output: {
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  day: 'Day 2',
                  platforms: ['instagram'],
                  post_type: 'static',
                  title: 'Studio proof',
                  caption: 'Show a specific customer result.',
                  creative_brief_id: 'tenant_dashboard_partial_stage-image',
                  status: 'approved',
                },
              ],
              image_creatives: [
                {
                  id: 'tenant_dashboard_partial_stage-image',
                  title: 'tenant_dashboard_partial_stage proof detail',
                  aspect_ratio: '4:5',
                  prompt: 'Macro detail of the finished product beside handwritten customer notes for tenant_dashboard_partial_stage with apiKey=dashboardTextSecret123.',
                  status: 'generated',
                  artifact_url: 'http://localhost./render.png?api_key=abc123',
                },
              ],
              video_scripts: [],
            },
          },
        },
        video_script: {
          output: {
            weekly_content_plan: {
              video_scripts: [
                {
                  id: 'tenant_dashboard_partial_stage-video',
                  title: 'Weekly proof reel',
                  duration_seconds: 30,
                  script_markdown: 'Open on product detail, cut to customer note, close with booking CTA.',
                  status: 'approved',
                },
              ],
            },
          },
        },
        publish_review: {
          output: {
            weekly_content_plan: {
              window_days: 7,
            },
          },
        },
      },
      publishingRequested: true,
    },
  } as unknown as SocialContentJobRuntimeDocument;

  const dashboard = buildSocialContentDashboardProjection(doc, {
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
  });

  assert.equal(dashboard.posts.length, 1);
  assert.equal(dashboard.assets.length, 2);
  assert.equal(dashboard.publishItems.length, 1);
  assert.equal(dashboard.post?.counts.scripts, 1);
  assert.notEqual(dashboard.assets[0].id, 'tenant_dashboard_partial_stage-image');
  assert.equal(dashboard.posts[0].previewAssetId, dashboard.assets[0].id);
  assert.equal(dashboard.assets[0].previewUrl?.startsWith('data:image/svg+xml;base64,'), true);
  assert.equal(JSON.stringify(dashboard).includes('api_key'), false);
  assert.equal(JSON.stringify(dashboard).includes('dashboardTextSecret123'), false);
  assert.equal(JSON.stringify(dashboard).includes('tenant_dashboard_partial_stage'), false);
});

test('social content dashboard projection includes playable rendered videos from safe job asset refs', () => {
  const jobId = 'mkt_dashboard_video_projection';
  const doc = {
    tenant_id: 'tenant_dashboard_video_projection',
    job_id: jobId,
    created_at: '2026-05-06T00:00:00.000Z',
    updated_at: '2026-05-06T00:00:00.000Z',
    inputs: {
      brand_url: 'https://brand.example',
      request: {
        jobType: 'weekly_social_content',
        businessName: 'Bright Studio',
        primaryGoal: 'Book discovery calls',
      },
    },
    brand_kit: {
      brand_name: 'Bright Studio',
    },
    social_content_runtime: {
      stageOrder: ['planning', 'video_script', 'video_render', 'publish_review'],
      stages: {
        planning: {
          output: {
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  day: 'Day 3',
                  platforms: ['tiktok'],
                  post_type: 'video',
                  title: 'Launch cut teaser',
                  caption: 'Show the tactile reveal and CTA.',
                  creative_brief_id: 'image-launch-cut',
                  status: 'approved',
                },
              ],
              image_creatives: [
                {
                  id: 'image-launch-cut',
                  title: 'Launch cut still',
                  aspect_ratio: '4:5',
                  prompt: 'Editorial hero still of the product reveal.',
                  status: 'generated',
                  artifact_url: '',
                },
              ],
              video_scripts: [],
            },
          },
          artifacts: [],
        },
        video_script: {
          output: {
            weekly_content_plan: {
              video_scripts: [
                {
                  id: 'video-script-launch-cut',
                  title: 'Launch cut script',
                  duration_seconds: 21,
                  script_markdown: 'Open on tactile detail, reveal the product, close with CTA.',
                  status: 'approved',
                },
              ],
            },
          },
          artifacts: [],
        },
        video_render: {
          output: {
            artifacts: [
              {
                id: 'video-tiktok-launch-cut',
                title: 'TikTok launch cut',
                status: 'ready',
                video_url: `/api/marketing/jobs/${jobId}/assets/video-tiktok-launch-cut`,
                poster_url: `/api/marketing/jobs/${jobId}/assets/video-tiktok-launch-cut-poster`,
                platform_slug: 'tiktok',
                family_id: 'launch-cut',
                duration_seconds: 21,
                aspect_ratio: '9:16',
              },
              {
                id: 'video-meta-unsafe',
                title: 'Meta unsafe video',
                status: 'ready',
                video_url: 'https://cdn.example.com/render.mp4?token=secret',
                poster_url: `/api/marketing/jobs/${jobId}/assets/video-meta-unsafe-poster`,
                platform_slug: 'meta',
                family_id: 'unsafe',
                duration_seconds: 30,
                aspect_ratio: '1:1',
              },
            ],
          },
          artifacts: [
            {
              id: 'video-tiktok-launch-cut',
              type: 'video',
              title: 'TikTok launch cut',
              status: 'ready',
              summary: 'TikTok launch cut render ready.',
              url: `/api/marketing/jobs/${jobId}/assets/video-tiktok-launch-cut`,
              metadata: {
                poster_url: `/api/marketing/jobs/${jobId}/assets/video-tiktok-launch-cut-poster`,
                platform_slug: 'tiktok',
                family_id: 'launch-cut',
                duration_seconds: 21,
                aspect_ratio: '9:16',
              },
            },
          ],
        },
        publish_review: {
          output: {
            weekly_content_plan: {
              window_days: 7,
            },
          },
          artifacts: [],
        },
      },
      publishingRequested: true,
    },
  } as unknown as SocialContentJobRuntimeDocument;

  const dashboard = buildSocialContentDashboardProjection(doc, {
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
  });

  const videoAssets = dashboard.assets.filter((asset) => asset.type === 'video_ad');
  assert.equal(videoAssets.length, 1);
  assert.equal(videoAssets[0].previewUrl, `/api/marketing/jobs/${jobId}/assets/video-tiktok-launch-cut`);
  assert.equal(videoAssets[0].thumbnailUrl, `/api/marketing/jobs/${jobId}/assets/video-tiktok-launch-cut-poster`);
  assert.equal(videoAssets[0].contentType, 'video/mp4');
  assert.equal(videoAssets[0].platform, 'tiktok');
  assert.equal(videoAssets[0].status, 'ready');
  assert.equal(dashboard.post?.counts.videoAds, 1);
  assert.equal(JSON.stringify(dashboard).includes('token=secret'), false);
  assert.equal(JSON.stringify(dashboard).includes('tenant_dashboard_video_projection'), false);
});

test('parseSocialContentWorkflowOutput accepts camelCase weeklyPlan key from Hermes', () => {
  const hermesOutput = {
    summary: 'Weekly plan ready.',
    weeklyPlan: {
      window_days: 7,
      posts: [
        {
          day: 'Day 1',
          platforms: ['instagram'],
          post_type: 'static',
          title: 'Post one',
          caption: 'Caption one.',
          creative_brief_id: 'image-one',
          status: 'approved',
        },
      ],
      image_creatives: [
        {
          id: 'image-one',
          title: 'Creative one',
          aspect_ratio: '4:5',
          prompt: 'A prompt.',
          status: 'generated',
          artifact_url: '',
        },
      ],
      video_scripts: [],
    },
  };

  const projection = parseSocialContentWorkflowOutput(hermesOutput);
  assert.notEqual(projection, null);
  assert.equal(projection!.weekly_content_plan.posts.length, 1);
  assert.equal(projection!.weekly_content_plan.window_days, 7);
  assert.equal(projection!.weekly_content_plan.image_creatives.length, 1);
});

test('parseSocialContentWorkflowOutput captures rendered video URLs from weekly plan video scripts', () => {
  const hermesOutput = {
    summary: 'Rendered weekly plan ready.',
    weekly_content_plan: {
      window_days: 7,
      posts: [],
      image_creatives: [],
      video_scripts: [
        {
          id: 'video-direct-url',
          title: 'Rendered direct URL',
          duration_seconds: 30,
          script_markdown: 'Direct URL render.',
          status: 'rendered',
          artifact_url: 'https://aries.example.com/api/marketing/jobs/job-123/assets/video-direct-url',
        },
        {
          id: 'video-nested-url',
          title: 'Rendered nested URL',
          duration_seconds: 15,
          script_markdown: 'Nested URL render.',
          status: 'rendered',
          rendered_video: {
            url: 'https://aries.example.com/api/marketing/jobs/job-123/assets/video-nested-url',
          },
        },
        {
          id: 'video-script-only',
          title: 'Script only',
          duration_seconds: 10,
          script_markdown: 'No render yet.',
          status: 'approved',
        },
      ],
    },
  };

  const projection = parseSocialContentWorkflowOutput(hermesOutput);
  assert.notEqual(projection, null);
  assert.equal(
    projection!.weekly_content_plan.video_scripts[0].artifact_url,
    'https://aries.example.com/api/marketing/jobs/job-123/assets/video-direct-url',
  );
  assert.equal(
    projection!.weekly_content_plan.video_scripts[1].artifact_url,
    'https://aries.example.com/api/marketing/jobs/job-123/assets/video-nested-url',
  );
  assert.equal(projection!.weekly_content_plan.video_scripts[2].artifact_url, '');
});

test('socialContentArtifactsFromProjection surfaces playable video URLs and preserves null for script-only entries', () => {
  const projection = parseSocialContentWorkflowOutput({
    summary: 'Rendered weekly plan ready.',
    weekly_content_plan: {
      window_days: 7,
      posts: [],
      image_creatives: [],
      video_scripts: [
        {
          id: 'video-ready',
          title: 'Playable render',
          duration_seconds: 20,
          script_markdown: 'Playable render.',
          status: 'rendered',
          url: 'https://aries.example.com/api/marketing/jobs/job-456/assets/video-ready',
        },
        {
          id: 'video-script-only',
          title: 'Script only',
          duration_seconds: 20,
          script_markdown: 'Still awaiting render.',
          status: 'approved',
        },
      ],
    },
  });

  assert.notEqual(projection, null);
  const artifacts = socialContentArtifactsFromProjection(projection!);
  assert.equal(artifacts.length, 2);
  assert.equal(
    artifacts[0].url,
    'https://aries.example.com/api/marketing/jobs/job-456/assets/video-ready',
  );
  assert.equal(artifacts[1].url, null);
});
