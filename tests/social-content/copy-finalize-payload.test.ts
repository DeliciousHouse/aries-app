import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSocialCopyFinalizeRequest } from '../../backend/social-content/copy-finalize-request';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

function makeDoc(overrides: Record<string, unknown> = {}): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_runtime',
    schema_version: '1.0.0',
    job_id: 'mkt_copy_finalize_payload',
    tenant_id: 'tenant_copy_finalize_payload',
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-18T00:00:00.000Z',
    status: 'in_progress',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { status: 'completed', outputs: {}, primary_output: null, started_at: null, completed_at: null },
      strategy: { status: 'completed', outputs: {}, primary_output: null, started_at: null, completed_at: null },
      production: { status: 'completed', outputs: {}, primary_output: null, started_at: null, completed_at: null },
      publish: { status: 'pending', outputs: {}, primary_output: null, started_at: null, completed_at: null },
    },
    approvals: { current: null, history: [] },
    publish_config: { enabled: false, channels: [] },
    brand_kit: {
      brand_name: 'Sugar and Leather',
      brand_voice_summary: 'Warm, elite, empowering.',
      offer_summary: 'Elite coaching for women leaders and executives.',
      positioning: 'Elite coaching network for women leaders.',
      audience: 'Women leaders seeking advancement without burnout.',
      tone_of_voice: 'Warm and premium.',
      style_vibe: 'Grounded editorial warmth.',
      colors: {
        primary: '#f6339a',
        secondary: '#a855f7',
        accent: '#e60076',
        palette: ['#f6339a', '#a855f7', '#e60076'],
      },
      logo_urls: [],
      font_families: ['Inter', 'Manrope'],
      external_links: [],
      extracted_at: '2026-05-18T00:00:00.000Z',
      source_url: 'https://sugarandleather.com/',
      canonical_url: 'https://sugarandleather.com/',
    },
    inputs: {
      request: {
        businessName: 'Sugar and Leather',
        businessType: 'Elite coaching',
        primaryGoal: 'Drive awareness and book discovery calls',
        goal: 'Drive awareness and book discovery calls',
        marketing_focus: 'Drive awareness and book discovery calls',
        offer: 'Elite coaching for women leaders',
        audience: 'Women leaders seeking advancement without burnout',
        toneOfVoice: 'Warm and premium',
        channels: ['instagram', 'meta'],
      },
      brand_url: 'https://sugarandleather.com/',
      competitor_url: 'https://competitor.example/',
      competitor_brand: 'Competitor',
      facebook_page_url: null,
      ad_library_url: null,
    },
    social_content_runtime: {
      stageOrder: ['planning', 'creative_review', 'video_render'],
      stages: {
        planning: {
          output: {
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  id: 'post-1',
                  day: 'Day 1',
                  platforms: ['instagram'],
                  post_type: 'static',
                  title: 'Founder story',
                  caption: 'Show the workshop ritual.',
                  creative_brief_id: 'image-founder-story',
                  status: 'approved',
                },
                {
                  id: 'post-2',
                  day: 'Day 4',
                  platforms: ['meta'],
                  post_type: 'static',
                  title: 'Proof carousel',
                  caption: 'Share outcome proof.',
                  creative_brief_id: 'image-proof-carousel',
                  status: 'approved',
                },
              ],
            },
          },
        },
        creative_review: {
          output: {
            weekly_content_plan: {
              image_creatives: [
                {
                  id: 'image-founder-story',
                  title: 'Workshop ritual still life',
                  prompt: 'Close-up of leather tools on warm bench.',
                  alt_text: 'Close-up of leather tools on a warm workbench.',
                  status: 'approved',
                  artifact_url: 'https://cdn.example.com/founder-story.png',
                },
                {
                  id: 'image-proof-carousel',
                  title: 'Client proof wall',
                  prompt: 'Editorial wall of handwritten customer notes.',
                  status: 'approved',
                  artifact_url: 'https://cdn.example.com/proof-carousel.png',
                },
              ],
            },
          },
        },
        video_render: {
          output: {
            weekly_content_plan: {
              video_scripts: [
                {
                  id: 'image-proof-carousel',
                  title: 'Proof reel',
                  script_markdown: 'Open with customer proof.',
                  rendered_video: {
                    artifact_url: 'https://cdn.example.com/proof-reel.mp4',
                  },
                  status: 'approved',
                },
              ],
            },
          },
        },
      },
    },
    ...overrides,
  } as unknown as SocialContentJobRuntimeDocument;
}

test('buildSocialCopyFinalizeRequest builds posts, approved images, and approved videos from the latest weekly plan', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc(),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.postCount, 2);
  assert.equal(result.approvedImageCount, 2);
  assert.equal(result.approvedVideoCount, 1);
  assert.equal(result.request.input.posts[0]?.approved_image?.url, 'https://cdn.example.com/founder-story.png');
  assert.equal(result.request.input.posts[1]?.approved_video?.url, 'https://cdn.example.com/proof-reel.mp4');
  assert.equal(result.request.input.posts[1]?.approved_video?.script_markdown, 'Open with customer proof.');
});

test('buildSocialCopyFinalizeRequest accepts camelCase weeklyPlan sources without changing the output contract', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      social_content_runtime: {
        stageOrder: ['planning', 'creative_review'],
        stages: {
          planning: {
            output: {
              weeklyPlan: {
                posts: [
                  {
                    postId: 'post-camel',
                    day: 'Day 2',
                    platform: 'linkedin',
                    title: 'Camel case proof',
                    summary: 'Fallback summary',
                    creativeBriefId: 'creative-camel',
                  },
                ],
              },
            },
          },
          creative_review: {
            output: {
              weeklyPlan: {
                image_creatives: [
                  {
                    creative_brief_id: 'creative-camel',
                    title: 'Camel image',
                    prompt: 'Editorial portrait',
                    previewUrl: 'https://cdn.example.com/camel.png',
                  },
                ],
              },
            },
          },
        },
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.request.input.posts[0]?.id, 'post-camel');
  assert.equal(result.request.input.posts[0]?.creative_brief_id, 'creative-camel');
  assert.equal(result.request.input.posts[0]?.channel, 'linkedin_feed');
  assert.equal(result.request.input.posts[0]?.draft_caption, 'Fallback summary');
});

test('buildSocialCopyFinalizeRequest prefers canonical weekly-plan post ids over creative_brief_id fallbacks', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      social_content_runtime: {
        stageOrder: ['planning', 'creative_review'],
        stages: {
          planning: {
            output: {
              weekly_content_plan: {
                posts: [
                  {
                    id: 'canonical-post-id',
                    creative_brief_id: 'creative-123',
                    platforms: ['instagram'],
                    title: 'Canonical id wins',
                    caption: 'Canonical id should stay stable.',
                  },
                ],
              },
            },
          },
          creative_review: {
            output: {
              weekly_content_plan: {
                image_creatives: [
                  {
                    id: 'creative-123',
                    title: 'Canonical image',
                    artifact_url: 'https://cdn.example.com/canonical.png',
                  },
                ],
              },
            },
          },
        },
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.request.input.posts[0]?.id, 'canonical-post-id');
  assert.equal(result.request.input.posts[0]?.approved_image?.post_id, 'canonical-post-id');
});

test('buildSocialCopyFinalizeRequest falls back to prompt/title when alt text is missing', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      social_content_runtime: {
        stageOrder: ['planning', 'creative_review'],
        stages: {
          planning: {
            output: {
              weekly_content_plan: {
                posts: [{ id: 'post-1', creative_brief_id: 'image-1', platforms: ['instagram'], title: 'Alt fallback' }],
              },
            },
          },
          creative_review: {
            output: {
              weekly_content_plan: {
                image_creatives: [
                  {
                    id: 'image-1',
                    title: 'Fallback title',
                    prompt: 'Fallback prompt',
                    artifact_url: 'https://cdn.example.com/fallback.png',
                  },
                ],
              },
            },
          },
        },
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.request.input.posts[0]?.approved_image?.alt_text, 'Fallback title');
});

test('buildSocialCopyFinalizeRequest maps platform aliases to stable channel identifiers', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      social_content_runtime: {
        stageOrder: ['planning', 'creative_review'],
        stages: {
          planning: {
            output: {
              weekly_content_plan: {
                posts: [
                  { id: 'meta-post', creative_brief_id: 'meta-image', platforms: ['meta'], title: 'Meta alias' },
                  { id: 'unknown-post', creative_brief_id: 'unknown-image', platforms: ['mastodon'], title: 'Unknown alias' },
                ],
              },
            },
          },
          creative_review: {
            output: {
              weekly_content_plan: {
                image_creatives: [
                  { id: 'meta-image', artifact_url: 'https://cdn.example.com/meta.png', title: 'Meta image' },
                  { id: 'unknown-image', artifact_url: 'https://cdn.example.com/unknown.png', title: 'Unknown image' },
                ],
              },
            },
          },
        },
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.request.input.posts[0]?.channel, 'facebook_feed');
  assert.equal(result.request.input.posts[1]?.channel, 'social_feed');
});

test('buildSocialCopyFinalizeRequest uses onboarding aliases for marketing focus and tone of voice', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      inputs: {
        request: {
          businessName: 'Sugar and Leather',
          businessType: 'Elite coaching',
          goal: 'Drive warmer discovery calls',
          marketingFocus: 'Drive warmer discovery calls',
          tone_of_voice: 'Direct but warm',
          offer: 'Elite coaching for women leaders',
          audience: 'Women leaders seeking advancement without burnout',
          channels: ['instagram', 'meta'],
        },
        brand_url: 'https://sugarandleather.com/',
        competitor_url: 'https://competitor.example/',
        competitor_brand: 'Competitor',
        facebook_page_url: null,
        ad_library_url: null,
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.request.input.onboarding.marketing_focus, 'Drive warmer discovery calls');
  assert.equal(result.request.input.onboarding.goal, 'Drive warmer discovery calls');
  assert.equal(result.request.input.onboarding.tone_of_voice, 'Direct but warm');
});

test('buildSocialCopyFinalizeRequest skips cleanly when no weekly-plan posts exist', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      social_content_runtime: {
        stageOrder: ['creative_review'],
        stages: {
          creative_review: {
            output: {
              weekly_content_plan: {
                image_creatives: [
                  { id: 'image-1', title: 'Image only', artifact_url: 'https://cdn.example.com/image.png' },
                ],
              },
            },
          },
        },
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(result, {
    kind: 'skip',
    workflow_key: 'social_copy_finalize',
    reason: 'no_weekly_plan_posts',
    postCount: 0,
    approvedImageCount: 1,
    approvedVideoCount: 0,
  });
});

test('buildSocialCopyFinalizeRequest skips cleanly when no approved image urls exist even if videos exist', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc({
      social_content_runtime: {
        stageOrder: ['planning', 'creative_review', 'video_render'],
        stages: {
          planning: {
            output: {
              weekly_content_plan: {
                posts: [{ id: 'post-1', creative_brief_id: 'video-1', platforms: ['meta'], title: 'Video only' }],
              },
            },
          },
          creative_review: {
            output: {
              weekly_content_plan: {
                image_creatives: [{ id: 'video-1', title: 'Missing URL image', artifact_url: '' }],
              },
            },
          },
          video_render: {
            output: {
              weekly_content_plan: {
                video_scripts: [
                  {
                    id: 'video-1',
                    title: 'Video proof',
                    rendered_video_url: 'https://cdn.example.com/video-proof.mp4',
                  },
                ],
              },
            },
          },
        },
      },
    }),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.deepEqual(result, {
    kind: 'skip',
    workflow_key: 'social_copy_finalize',
    reason: 'no_approved_images',
    postCount: 1,
    approvedImageCount: 0,
    approvedVideoCount: 1,
  });
});
