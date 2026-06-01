export const SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY = 'social_content_weekly';
export const SOCIAL_COPY_FINALIZE_WORKFLOW_KEY = 'social_copy_finalize';
export const SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION = '2026-05-social-content-weekly-v2';

export const SOCIAL_CONTENT_DEFAULT_SCOPE = {
  window_days: 7,
  static_post_count: 7,
  // Image-story posts requested per weekly run. Aries synthesizes this many
  // `surface='story'` posts from the run's generated creatives (see
  // synthesize-publish-posts.ts), composing each into a 9:16 canvas with the
  // post headline + brand CTA baked in, and they publish LIVE through the
  // scheduled-dispatch path (Meta cannot natively schedule stories, so they go
  // out live when the worker drains the row). Default 1 = ON: every weekly run
  // ships one image story alongside the feed posts. Set to 0 to disable.
  story_count: 1,
  image_creative_count: 6,
  video_script_count: 1,
  video_render_count: 0,
  channels: ['meta', 'instagram'],
} as const;

export const SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT = 6;
export const SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT = 1;

export const SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS = [
  'split-screen',
  'before/after',
  'side-by-side comparison',
  'two-panel layout',
  'old way vs new way',
  'generic stock office',
] as const;
