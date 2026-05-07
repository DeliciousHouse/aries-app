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

export interface InstagramFeedCarouselProps {
  author: PostPreviewAuthor;
  slides: PostPreviewMedia[];
  caption: string;
  initialSlideIndex?: number;
  likeCountLabel?: string;
}

export default function InstagramFeedCarousel(props: InstagramFeedCarouselProps) {
  const slides = props.slides ?? [];
  const totalSlides = slides.length;
  const activeIndex = clampIndex(props.initialSlideIndex ?? 0, totalSlides);

  const truncation = truncateCaption(
    props.caption,
    INSTAGRAM_CAPTION_TRUNCATE_AT,
    INSTAGRAM_MORE_LABEL,
  );
  const likeLabel = props.likeCountLabel ?? '0 likes';

  return (
    <PostFrame
      platform="instagram"
      postType="carousel"
      aspectRatio="1:1"
      testId="post-preview-instagram-carousel"
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

      <div
        data-role="post-carousel"
        data-slide-count={totalSlides}
        data-active-slide={activeIndex}
        className="relative"
      >
        {slides.map((slide, index) => (
          <div
            key={`${slide.url}-${index}`}
            data-role="carousel-slide"
            data-slide-index={index}
            data-slide-active={index === activeIndex ? 'true' : 'false'}
            hidden={index !== activeIndex}
          >
            <PreviewImage
              media={slide}
              aspectRatio="1:1"
              imageRole="post-image"
              priority={index === 0}
            />
          </div>
        ))}
        <div
          data-role="carousel-counter"
          aria-hidden="true"
          className="absolute right-3 top-3 rounded-full bg-black/55 px-2 py-1 text-xs font-medium text-white/85"
        >
          {Math.min(activeIndex + 1, Math.max(totalSlides, 1))}/{Math.max(totalSlides, 1)}
        </div>
      </div>

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

      <div
        data-role="carousel-dots"
        aria-hidden="true"
        className="flex items-center justify-center gap-1.5 pt-2"
      >
        {slides.map((_, index) => (
          <span
            key={`dot-${index}`}
            data-role="carousel-dot"
            data-dot-active={index === activeIndex ? 'true' : 'false'}
            className={`h-1.5 w-1.5 rounded-full ${
              index === activeIndex ? 'bg-blue-400' : 'bg-white/35'
            }`}
          />
        ))}
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

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value >= length) return length - 1;
  return Math.floor(value);
}
