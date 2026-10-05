export function normalizeMarketingChannel(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, '-');
  return normalized === 'meta' ? 'facebook' : normalized;
}

export function isMetaAdsChannel(value: string): boolean {
  return ['meta-ads', 'facebook-ads', 'meta-ads-manager'].includes(normalizeMarketingChannel(value));
}

export function selectableMarketingChannels(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeMarketingChannel).filter((value) => !isMetaAdsChannel(value))));
}

export function assertNoMetaAdsChannels(values: string[] | null | undefined): void {
  if (values?.some(isMetaAdsChannel)) throw new Error('meta_ads_coming_soon');
}
