export function isBrandVoiceManuallyEdited(
  brandVoice: string | null | undefined,
  scrapedBrandVoice: string | null | undefined,
): boolean {
  const normalizedBrandVoice = brandVoice?.trim() || '';
  if (!normalizedBrandVoice) {
    return false;
  }

  const normalizedScrapedBrandVoice = scrapedBrandVoice?.trim() || '';
  return !normalizedScrapedBrandVoice || normalizedBrandVoice !== normalizedScrapedBrandVoice;
}

export function resolveBrandVoiceForPreview(
  currentBrandVoice: string,
  scrapedBrandVoice: string | null | undefined,
  manuallyEdited: boolean,
): string {
  if (manuallyEdited) {
    return currentBrandVoice;
  }

  return scrapedBrandVoice?.trim() || '';
}
