'use client';

import { useMemo, useState } from 'react';
import { Archive, FileImage, FileText, Globe } from 'lucide-react';

import { safeHref } from '@/lib/safe-href';
import VideoPreview from '@/frontend/components/video-preview';

type MediaPreviewProps = {
  src?: string | null;
  poster?: string | null;
  alt: string;
  contentType?: string | null;
  className?: string;
  imageClassName?: string;
  emptyLabel?: string;
  nonImageLabel?: string;
  /**
   * When set, wraps the preview in an anchor that opens `href` in a new tab.
   * Wrapping only applies to the image and fallback-placeholder rendering
   * paths. In video mode `href` is intentionally ignored: wrapping a
   * `<video>` in `<a>` swallows clicks on the native controls and breaks
   * play/pause. Callers that want a separate "open in new tab" affordance
   * for videos should render their own link next to `<MediaPreview>`.
   */
  href?: string | null;
};

function stripUrlSuffix(src: string): string {
  // Strip ?query and #hash before extension checks so signed URLs like
  // `.../meta-ads.mp4?sig=abc` are still detectable as videos/images.
  const hashIndex = src.indexOf('#');
  const trimmed = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const queryIndex = trimmed.indexOf('?');
  return queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed;
}

function imageLike(src: string | null | undefined, contentType?: string | null): boolean {
  if (typeof contentType === 'string' && contentType.startsWith('image/')) {
    return true;
  }
  if (!src) return false;
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(stripUrlSuffix(src));
}

function videoLike(src: string | null | undefined, contentType?: string | null): boolean {
  if (typeof contentType === 'string' && contentType.startsWith('video/')) {
    return true;
  }
  if (!src) return false;
  return /\.(mp4|mov|webm|m4v|ogv|ogg)$/i.test(stripUrlSuffix(src));
}

function isHostInRemotePatterns(src: string): boolean {
  try {
    const url = new URL(src);
    const hostname = url.hostname;
    // Check against known patterns: localhost, HERMES_GATEWAY_URL, APP_BASE_URL, IMAGES_CDN_HOST
    const allowedHosts = new Set<string>();
    allowedHosts.add('localhost');

    if (process.env.NEXT_PUBLIC_HERMES_GATEWAY_URL) {
      try {
        const hermesUrl = new URL(process.env.NEXT_PUBLIC_HERMES_GATEWAY_URL);
        allowedHosts.add(hermesUrl.hostname);
      } catch (e) {
        // Invalid URL, skip
      }
    }

    if (process.env.NEXT_PUBLIC_APP_BASE_URL) {
      try {
        const appUrl = new URL(process.env.NEXT_PUBLIC_APP_BASE_URL);
        allowedHosts.add(appUrl.hostname);
      } catch (e) {
        // Invalid URL, skip
      }
    }

    if (process.env.NEXT_PUBLIC_IMAGES_CDN_HOST) {
      allowedHosts.add(process.env.NEXT_PUBLIC_IMAGES_CDN_HOST);
    }

    return allowedHosts.has(hostname);
  } catch (e) {
    return false;
  }
}

export default function MediaPreview(props: MediaPreviewProps) {
  const [failed, setFailed] = useState(false);
  const [useNativeFallback, setUseNativeFallback] = useState(false);

  const mode = useMemo<'image' | 'video' | 'fallback'>(() => {
    if (!props.src || failed) return 'fallback';
    if (videoLike(props.src, props.contentType)) return 'video';
    if (imageLike(props.src, props.contentType)) return 'image';
    return 'fallback';
  }, [failed, props.contentType, props.src]);

  // Check if src host is in remotePatterns; if not, warn in dev and use native fallback
  useMemo(() => {
    if (props.src && imageLike(props.src, props.contentType) && !isHostInRemotePatterns(props.src)) {
      if (process.env.NODE_ENV === 'development') {
        try {
          const url = new URL(props.src);
          console.warn('[media-preview] URL host not in remotePatterns:', url.hostname);
        } catch (e) {
          console.warn('[media-preview] Invalid URL:', props.src);
        }
      }
      setUseNativeFallback(true);
    }
  }, [props.src, props.contentType]);

  const fallbackPresentation = useMemo(() => {
    if (!props.src) {
      return {
        icon: <FileImage className="h-6 w-6" />,
        label: props.emptyLabel || 'Preview pending',
      };
    }
    if (failed) {
      // An <img> with a real src triggered `onError`. The Hermes media route
      // returns 404 for both "file evicted from cache" and "tenant does not
      // own this basename" — we can't tell which from the browser. Either way,
      // "Preview unavailable" reads like a bug; "Preview archived" reads like
      // a known retention behavior, which matches reality far more often
      // (older campaigns whose creative assets aged out of the Hermes cache).
      return {
        icon: <Archive className="h-6 w-6" />,
        label: 'Preview archived',
      };
    }
    return {
      icon: props.contentType?.includes('html') ? <Globe className="h-6 w-6" /> : <FileText className="h-6 w-6" />,
      label: props.nonImageLabel || 'Open asset preview',
    };
  }, [failed, props.contentType, props.emptyLabel, props.nonImageLabel, props.src]);

  // Guard against `javascript:` / `data:` / other non-http(s) schemes leaking
  // in via tenant-provided or pipeline-generated URLs; fall back to the
  // non-link rendering if the href is not safe to navigate to.
  const validatedHref = safeHref(props.href);

  if (mode === 'video' && props.src) {
    return (
      <div className={props.className}>
        <VideoPreview
          src={props.src}
          poster={props.poster}
          className={props.imageClassName || 'h-full w-full object-contain bg-black'}
        />
      </div>
    );
  }

  const inner = mode === 'image' && props.src ? (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={props.src}
      alt={props.alt}
      data-fallback={useNativeFallback ? 'true' : undefined}
      className={props.imageClassName || 'h-full w-full object-cover'}
      onError={() => setFailed(true)}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/45 transition-colors group-hover:text-white/70">
      {fallbackPresentation.icon}
      <span className="px-4 text-xs font-medium uppercase tracking-[0.2em]">{fallbackPresentation.label}</span>
    </div>
  );

  if (validatedHref) {
    return (
      <a
        href={validatedHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={props.alt}
        className={`${props.className ?? ''} group block transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
      >
        {inner}
      </a>
    );
  }

  return <div className={props.className}>{inner}</div>;
}

export { imageLike, videoLike };
