const CONNECTED_PROFILE_LABELS: Record<string, string> = {
  facebook: 'Meta',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  x: 'X',
  youtube: 'YouTube',
  reddit: 'Reddit',
  tiktok: 'TikTok',
};

export function connectedProfileLabel(platform: string, fallback: string): string {
  return CONNECTED_PROFILE_LABELS[platform] || fallback || platform;
}
