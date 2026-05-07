'use client';

import { Bookmark, Heart, MessageCircle, MoreHorizontal, Send } from 'lucide-react';

import {
  CaptionRenderer,
  INSTAGRAM_CAPTION_TRUNCATE_AT,
  INSTAGRAM_MORE_LABEL,
  PostFrame,
  PostHeader,
  PreviewImage,
  truncateCaption,
  type PostPreviewAuthor,
  type PostPreviewMedia,
} from './shared';

export type InstagramFeedSingleAspectRatio = '4:5' | '1:1';

export interface InstagramFeedSingleProps {
  author: PostPreviewAuthor;
  media: PostPreviewMedia;
  caption: string;
  aspectRatio?: InstagramFeedSingleAspectRatio;
  likeCountLabel?: string;
}

export default function InstagramFeedSingle(props: InstagramFeedSingleProps) {
  const aspect: InstagramFeedSingleAspectRatio = props.aspectRatio ?? '4:5';
  const truncation = truncateCaption(
    props.caption,
    INSTAGRAM_CAPTION_TRUNCATE_AT,
    INSTAGRAM_MORE_LABEL,
  );
  const likeLabel = props.likeCountLabel ?? '0 likes';

  return (
    <PostFrame
      platform="instagram"
      postType="single"
      aspectRatio={aspect}
      testId="post-preview-instagram-single"
    >
      <div className="flex items-center justify-between pr-2">
        <PostHeader platform="instagram" author={props.author} />
        <span
          data-role="post-more-affordance"
          aria-hidden="true"
          className="p-2 text-white/55"
        >
          <MoreHorizontal className="h-4 w-4" />
        </span>
      </div>

      <PreviewImage
        media={props.media}
        aspectRatio={aspect}
        imageRole="post-image"
      />

      <div
        data-role="post-actions"
        aria-hidden="true"
        className="flex items-center gap-4 px-4 pt-3"
      >
        <Heart className="h-6 w-6 text-white" />
        <MessageCircle className="h-6 w-6 text-white" />
        <Send className="h-6 w-6 text-white" />
        <Bookmark className="ml-auto h-6 w-6 text-white" />
      </div>

      <p data-role="post-likes" className="px-4 pt-2 text-sm font-semibold text-white">
        {likeLabel}
      </p>

      <div className="px-4 pb-4 pt-1">
        <CaptionRenderer
          text={props.caption}
          truncation={truncation}
          authorName={props.author.name}
        />
      </div>
    </PostFrame>
  );
}
