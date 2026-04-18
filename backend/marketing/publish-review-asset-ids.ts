function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

type PublishReviewAssetIdInput = {
  platformSlug: string;
  previewIndex: number;
  explicitPreviewAssetId?: unknown;
};

type PublishReviewMediaAssetIdInput = PublishReviewAssetIdInput & {
  mediaIndex: number;
};

type PublishReviewLinkedAssetIdInput = PublishReviewAssetIdInput & {
  suffix: 'contract' | 'brief' | 'landing-page';
};

export function publishReviewPreviewAssetPrefix({
  platformSlug,
  previewIndex,
  explicitPreviewAssetId,
}: PublishReviewAssetIdInput): string {
  return stringValue(explicitPreviewAssetId) || `platform-preview-${platformSlug}-${previewIndex + 1}`;
}

export function publishReviewMediaAssetId(input: PublishReviewMediaAssetIdInput): string {
  const explicitPreviewAssetId = stringValue(input.explicitPreviewAssetId);
  const prefix = publishReviewPreviewAssetPrefix(input);
  if (explicitPreviewAssetId && input.mediaIndex === 0) {
    return prefix;
  }
  return `${prefix}-media-${input.mediaIndex + 1}`;
}

export function publishReviewLinkedAssetId(input: PublishReviewLinkedAssetIdInput): string {
  return `${publishReviewPreviewAssetPrefix(input)}-asset-${input.suffix}`;
}

export function legacyPublishReviewMediaAssetId(platformSlug: string, mediaIndex: number): string {
  return `platform-preview-${platformSlug}-media-${mediaIndex + 1}`;
}

export function legacyPublishReviewLinkedAssetId(
  platformSlug: string,
  suffix: 'contract' | 'brief' | 'landing-page',
): string {
  return `platform-preview-${platformSlug}-asset-${suffix}`;
}
