export type ProviderKey = 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube' | 'tiktok' | 'reddit';

export interface ProviderConfig {
  key: ProviderKey;
  family: 'meta' | 'linkedin' | 'x' | 'youtube' | 'tiktok' | 'reddit';
  display_name: string;
  default_scopes: string[];
  adapter: string;
}

export const PROVIDER_REGISTRY: Record<ProviderKey, ProviderConfig> = {
  facebook: { key: 'facebook', family: 'meta', display_name: 'Facebook', default_scopes: ['pages_manage_posts'], adapter: 'meta' },
  instagram: { key: 'instagram', family: 'meta', display_name: 'Instagram', default_scopes: ['instagram_content_publish'], adapter: 'meta' },
  linkedin: { key: 'linkedin', family: 'linkedin', display_name: 'LinkedIn', default_scopes: ['w_member_social'], adapter: 'linkedin' },
  x: { key: 'x', family: 'x', display_name: 'X', default_scopes: ['tweet.read', 'tweet.write'], adapter: 'x' },
  youtube: { key: 'youtube', family: 'youtube', display_name: 'YouTube', default_scopes: ['youtube.upload'], adapter: 'youtube' },
  tiktok: { key: 'tiktok', family: 'tiktok', display_name: 'TikTok', default_scopes: ['video.publish'], adapter: 'tiktok' },
  reddit: { key: 'reddit', family: 'reddit', display_name: 'Reddit', default_scopes: ['submit'], adapter: 'reddit' }
};
