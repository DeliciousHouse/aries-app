export const SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY = 'social_content_weekly';
export const SOCIAL_COPY_FINALIZE_WORKFLOW_KEY = 'social_copy_finalize';
export const SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION = '2026-05-social-content-weekly-v2';

export const SOCIAL_CONTENT_DEFAULT_SCOPE = {
  window_days: 7,
  static_post_count: 7,
  // Image-story posts requested per weekly run. Default 0 = OFF: no story posts
  // are synthesized and the Hermes request is byte-for-byte equivalent to the
  // pre-stories behavior. Raise > 0 to request image stories alongside feed
  // posts; Aries synthesizes that many `surface='story'` posts from the run's
  // generated creatives (see synthesize-publish-posts.ts) and they publish live
  // through the scheduled-dispatch path. Stories cannot be natively scheduled on
  // Meta, so they publish live when the worker drains the row.
  story_count: 0,
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
