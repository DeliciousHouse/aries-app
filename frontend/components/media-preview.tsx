'use client';

import { useMemo, useState } from 'react';
import { FileImage, FileText, Globe } from 'lucide-react';

import { safeHref } from '@/lib/safe-href';

type MediaPreviewProps = {
  src?: string | null;
  alt: string;
  contentType?: string | null;
  className?: string;
  imageClassName?: string;
  emptyLabel?: string;
  nonImageLabel?: string;
  /**
   * When set, wraps the preview (image or fallback label) in an anchor that
   * opens `href` in a new tab. Lets callers make the thumbnail a click target
   * for videos, landing pages, or any non-image asset where inline rendering
   * only shows a placeholder.
   */
  href?: string | null;
};

function imageLike(src: string | null | undefined, contentType?: string | null): boolean {
  if (typeof contentType === 'string' && contentType.startsWith('image/')) {
    return true;
  }
  return !!src && /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(src);
}

export default function MediaPreview(props: MediaPreviewProps) {
  const [failed, setFailed] = useState(false);

  const presentation = useMemo(() => {
    if (!props.src) {
      return {
        icon: <FileImage className="h-6 w-6" />,
        label: props.emptyLabel || 'Preview pending',
      };
    }
    if (!imageLike(props.src, props.contentType) || failed) {
      return {
        icon: props.contentType?.includes('html') ? <Globe className="h-6 w-6" /> : <FileText className="h-6 w-6" />,
        label: failed ? 'Preview unavailable' : props.nonImageLabel || 'Open asset preview',
      };
    }
    return null;
  }, [failed, props.contentType, props.emptyLabel, props.nonImageLabel, props.src]);

  const inner = !presentation && props.src ? (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={props.src}
      alt={props.alt}
      className={props.imageClassName || 'h-full w-full object-cover'}
      onError={() => setFailed(true)}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/45 transition-colors group-hover:text-white/70">
      {presentation?.icon}
      <span className="px-4 text-xs font-medium uppercase tracking-[0.2em]">{presentation?.label}</span>
    </div>
  );

  // Guard against `javascript:` / `data:` / other non-http(s) schemes leaking
  // in via tenant-provided or pipeline-generated URLs; fall back to the
  // non-link rendering if the href is not safe to navigate to.
  const validatedHref = safeHref(props.href);
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
