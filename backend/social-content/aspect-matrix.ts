export type SocialContentImageChannel = 'meta' | 'instagram';

export type SocialContentMediaPostType =
  | 'single_image'
  | 'carousel'
  | 'link_card'
  | 'video';

export type SocialContentAspectRatio = '4:5' | '1:1' | '1.91:1' | '9:16';

export interface ResolveSocialContentAspectRatioInput {
  channel: SocialContentImageChannel;
  postType: SocialContentMediaPostType;
}

const ASPECT_MATRIX: Record<
  SocialContentImageChannel,
  Record<SocialContentMediaPostType, SocialContentAspectRatio>
> = {
  instagram: {
    single_image: '4:5',
    carousel: '1:1',
    link_card: '1.91:1',
    video: '9:16',
  },
  meta: {
    single_image: '1:1',
    carousel: '1:1',
    link_card: '1.91:1',
    video: '9:16',
  },
};

export function resolveSocialContentAspectRatio(
  input: ResolveSocialContentAspectRatioInput,
): SocialContentAspectRatio {
  return ASPECT_MATRIX[input.channel][input.postType];
}

// Instagram wins on a tie because 4:5 center-crops cleanly to Meta 1:1,
// but 1:1 cannot be expanded to 4:5 without generated bleed.
export function resolveDominantImageChannel(
  channels: readonly string[],
): SocialContentImageChannel {
  if (channels.includes('instagram')) return 'instagram';
  if (channels.includes('meta')) return 'meta';
  return 'instagram';
}
