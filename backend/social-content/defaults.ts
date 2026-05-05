export const SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY = 'social_content_weekly';
export const SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION = '2026-05-social-content-weekly-v1';

export const SOCIAL_CONTENT_DEFAULT_SCOPE = {
  window_days: 7,
  static_post_count: 3,
  image_creative_count: 2,
  video_script_count: 1,
  video_render_count: 0,
  channels: ['meta', 'instagram'],
} as const;

export const SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS = [
  'split-screen',
  'before/after',
  'side-by-side comparison',
  'two-panel layout',
  'old way vs new way',
  'generic stock office',
] as const;
