export { default as InstagramFeedSingle } from './InstagramFeedSingle';
export type {
  InstagramFeedSingleAspectRatio,
  InstagramFeedSingleProps,
} from './InstagramFeedSingle';

export { default as InstagramFeedCarousel } from './InstagramFeedCarousel';
export type { InstagramFeedCarouselProps } from './InstagramFeedCarousel';

export { default as FacebookFeedSingle } from './FacebookFeedSingle';
export type { FacebookFeedSingleProps } from './FacebookFeedSingle';

export { default as FacebookFeedLinkCard, extractDomain } from './FacebookFeedLinkCard';
export type { FacebookFeedLinkCardProps } from './FacebookFeedLinkCard';

export {
  CaptionRenderer,
  FACEBOOK_CAPTION_TRUNCATE_AT,
  FACEBOOK_MORE_LABEL,
  INSTAGRAM_CAPTION_TRUNCATE_AT,
  INSTAGRAM_MORE_LABEL,
  PostFrame,
  PostHeader,
  PreviewImage,
  aspectClass,
  aspectNumeric,
  captionWithHashtags,
  truncateCaption,
} from './shared';
export type {
  CaptionRendererProps,
  CaptionTruncation,
  PostFrameProps,
  PostHeaderProps,
  PostPreviewAspectRatio,
  PostPreviewAuthor,
  PostPreviewMedia,
  PostPreviewPlatform,
  PostPreviewType,
  PreviewImageProps,
} from './shared';
