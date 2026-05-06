'use client';

import { Globe2, MessageCircle, MoreHorizontal, Share2, ThumbsUp } from 'lucide-react';

import {
  CaptionRenderer,
  FACEBOOK_CAPTION_TRUNCATE_AT,
  FACEBOOK_MORE_LABEL,
  PostFrame,
  PostHeader,
  PreviewImage,
  truncateCaption,
  type PostPreviewAuthor,
  type PostPreviewMedia,
} from './shared';

export interface FacebookFeedLinkCardProps {
  author: PostPreviewAuthor;
  media: PostPreviewMedia;
  caption: string;
  link: {
    url: string;
    title: string;
    description?: string;
  };
  reactionCountLabel?: string;
  commentCountLabel?: string;
  shareCountLabel?: string;
}

export default function FacebookFeedLinkCard(props: FacebookFeedLinkCardProps) {
  const truncation = truncateCaption(
    props.caption,
    FACEBOOK_CAPTION_TRUNCATE_AT,
    FACEBOOK_MORE_LABEL,
  );
  const reactions = props.reactionCountLabel ?? '0';
  const comments = props.commentCountLabel ?? '0 comments';
  const shares = props.shareCountLabel ?? '0 shares';
  const linkHostLabel = extractDomain(props.link.url);

  return (
    <PostFrame
      platform="facebook"
      postType="link_card"
      aspectRatio="1.91:1"
      testId="post-preview-facebook-link-card"
    >
      <div className="flex items-center justify-between pr-2">
        <div className="flex flex-1 items-center">
          <PostHeader
            platform="facebook"
            author={{
              ...props.author,
              timestampLabel: props.author.timestampLabel ?? 'Just now',
            }}
          />
          <Globe2 className="-ml-1 h-3 w-3 text-white/55" aria-hidden="true" />
        </div>
        <span
          data-role="post-more-affordance"
          aria-hidden="true"
          className="p-2 text-white/55"
        >
          <MoreHorizontal className="h-4 w-4" />
        </span>
      </div>

      <div className="px-4 pb-3">
        <CaptionRenderer text={props.caption} truncation={truncation} />
      </div>

      <a
        data-role="link-card"
        data-link-host={linkHostLabel}
        href={props.link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block border-y border-white/8 bg-black/40 transition hover:bg-black/30"
      >
        <PreviewImage
          media={props.media}
          aspectRatio="1.91:1"
          imageRole="link-card-image"
        />
        <div data-role="link-card-meta" className="px-4 py-3">
          <p
            data-role="link-card-host"
            className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55"
          >
            {linkHostLabel}
          </p>
          <p
            data-role="link-card-title"
            className="mt-1 text-sm font-semibold leading-snug text-white"
          >
            {props.link.title}
          </p>
          {props.link.description ? (
            <p
              data-role="link-card-description"
              className="mt-1 text-xs leading-snug text-white/65"
            >
              {props.link.description}
            </p>
          ) : null}
        </div>
      </a>

      <div
        data-role="post-engagement-counts"
        className="flex items-center justify-between px-4 py-2 text-xs text-white/55"
      >
        <span data-role="post-reactions">{reactions}</span>
        <span>
          <span data-role="post-comments" className="mr-3">
            {comments}
          </span>
          <span data-role="post-shares">{shares}</span>
        </span>
      </div>

      <div
        data-role="post-actions"
        aria-hidden="true"
        className="flex items-center justify-around border-t border-white/8 px-2 py-2"
      >
        <span
          data-role="post-action-like"
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-white/75"
        >
          <ThumbsUp className="h-4 w-4" />
          <span>Like</span>
        </span>
        <span
          data-role="post-action-comment"
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-white/75"
        >
          <MessageCircle className="h-4 w-4" />
          <span>Comment</span>
        </span>
        <span
          data-role="post-action-share"
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-white/75"
        >
          <Share2 className="h-4 w-4" />
          <span>Share</span>
        </span>
      </div>
    </PostFrame>
  );
}

export function extractDomain(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./i, '').toUpperCase();
  } catch {
    return rawUrl.toUpperCase();
  }
}
