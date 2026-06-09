export type ProviderKey =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'x'
  | 'youtube'
  | 'tiktok'
  | 'reddit'
  | 'openai'
  | 'slack';

export interface ProviderConfig {
  key: ProviderKey;
  family: 'meta' | 'linkedin' | 'x' | 'youtube' | 'tiktok' | 'reddit' | 'openai' | 'slack';
  display_name: string;
  default_scopes: string[];
  adapter: string;
}

export const PROVIDER_REGISTRY: Record<ProviderKey, ProviderConfig> = {
  facebook: {
    key: 'facebook',
    family: 'meta',
    display_name: 'Facebook',
    default_scopes: [
      'pages_show_list',
      'pages_manage_posts',
      'pages_read_engagement',
      'pages_manage_metadata',
      'business_management',
      'instagram_basic',
      'instagram_content_publish',
    ],
    adapter: 'meta',
  },
  instagram: {
    key: 'instagram',
    family: 'meta',
    display_name: 'Instagram',
    default_scopes: [
      'instagram_basic',
      'instagram_content_publish',
      'pages_show_list',
      'pages_read_engagement',
      'business_management',
    ],
    adapter: 'meta',
  },
  linkedin: { key: 'linkedin', family: 'linkedin', display_name: 'LinkedIn', default_scopes: ['w_member_social'], adapter: 'linkedin' },
  x: {
    key: 'x',
    family: 'x',
    display_name: 'X',
    default_scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
    adapter: 'x',
  },
  youtube: {
    key: 'youtube',
    family: 'youtube',
    display_name: 'YouTube',
    default_scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    adapter: 'youtube',
  },
  tiktok: { key: 'tiktok', family: 'tiktok', display_name: 'TikTok', default_scopes: ['video.publish'], adapter: 'tiktok' },
  reddit: { key: 'reddit', family: 'reddit', display_name: 'Reddit', default_scopes: ['submit'], adapter: 'reddit' },
  openai: {
    key: 'openai',
    family: 'openai',
    display_name: 'ChatGPT / OpenAI',
    default_scopes: ['openid', 'profile'],
    adapter: 'openai',
  },
  slack: {
    key: 'slack',
    family: 'slack',
    display_name: 'Slack',
    // chat:write to post; channels:read + groups:read to list channels for the
    // picker. No chat:write.public — we rely on the picked channel + an invite
    // hint, so we never post to channels the bot was not added to.
    default_scopes: ['chat:write', 'channels:read', 'groups:read'],
    adapter: 'slack',
  },
};
