import assert from 'node:assert/strict';
import test from 'node:test';

import { SOCIAL_COPY_FINALIZE_WORKFLOW_KEY } from '@/backend/social-content/defaults';
import { buildSocialCopyFinalizeRequest } from '@/backend/social-content/copy-finalize-request';
import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';

function makeDoc(overrides: Record<string, unknown> = {}): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_runtime',
    schema_version: '1.0.0',
    job_id: 'mkt_social_copy_finalize',
    tenant_id: 'tenant_social_copy_finalize',
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
      stageOrder: ['planning', 'creative_review'],
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
      },
    },
    ...overrides,
  } as unknown as SocialContentJobRuntimeDocument;
}

test('buildSocialCopyFinalizeRequest exports the Aries-side workflow key', () => {
  assert.equal(SOCIAL_COPY_FINALIZE_WORKFLOW_KEY, 'social_copy_finalize');
});

test('buildSocialCopyFinalizeRequest builds a Hermes payload from canonical weekly-plan posts and approved images', () => {
  const result = buildSocialCopyFinalizeRequest({
    doc: makeDoc(),
    ariesRunId: 'arun_social_copy_finalize',
    callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
  });

  assert.equal(result.kind, 'build');
  if (result.kind !== 'build') return;

  assert.equal(result.request.workflow_key, 'social_copy_finalize');
  assert.equal(result.request.input.brand.name, 'Sugar and Leather');
  assert.equal(result.request.input.onboarding.marketing_focus, 'Drive awareness and book discovery calls');
  assert.deepEqual(result.request.input.onboarding.channels, ['instagram', 'meta']);
  assert.equal(result.request.input.posts[0]?.id, 'post-1');
  assert.equal(result.request.input.posts[0]?.channel, 'instagram_feed');
  assert.equal(result.request.input.posts[0]?.creative_brief_id, 'image-founder-story');
  assert.equal(result.request.input.posts[0]?.approved_image?.url, 'https://cdn.example.com/founder-story.png');
  assert.equal(result.request.input.posts[0]?.approved_image?.alt_text, 'Close-up of leather tools on a warm workbench.');
  assert.equal(result.request.input.posts[1]?.id, 'post-2');
  assert.equal(result.request.input.posts[1]?.channel, 'facebook_feed');
  assert.equal(result.request.input.posts[1]?.approved_image?.url, 'https://cdn.example.com/proof-carousel.png');
  assert.match(
    result.request.input.output_contract.posts.id,
    /must exactly echo input\.posts\[\]\.id from weekly-plan\.json/,
  );
  assert.equal(result.request.input.constraints.preserve_input_post_ids, true);
});

test('buildSocialCopyFinalizeRequest skips payload creation when no approved image URLs are available', () => {
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
                    id: 'post-1',
                    day: 'Day 1',
                    platforms: ['instagram'],
                    post_type: 'static',
                    title: 'Founder story',
                    caption: 'Show the workshop ritual.',
                    creative_brief_id: 'image-founder-story',
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
                    status: 'approved',
                    artifact_url: '',
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
    approvedVideoCount: 0,
  });
});
