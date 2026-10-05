const CONNECTED_PROFILE_LABELS: Record<string, string> = {
  facebook: 'Facebook Page',
  meta: 'Facebook Page',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  x: 'X',
  youtube: 'YouTube',
  reddit: 'Reddit',
};

export function connectedProfileLabel(platform: string, fallback: string): string {
  return CONNECTED_PROFILE_LABELS[platform] || fallback || platform;
}
