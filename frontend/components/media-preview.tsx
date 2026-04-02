'use client';

import { useMemo, useState } from 'react';
import { FileImage, FileText, Globe } from 'lucide-react';

type MediaPreviewProps = {
  src?: string | null;
  alt: string;
  contentType?: string | null;
  className?: string;
  imageClassName?: string;
  emptyLabel?: string;
  nonImageLabel?: string;
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

  if (!presentation && props.src) {
    return (
      <div className={props.className}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={props.src}
          alt={props.alt}
          className={props.imageClassName || 'h-full w-full object-cover'}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  return (
    <div className={props.className}>
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/45">
        {presentation?.icon}
        <span className="px-4 text-xs font-medium uppercase tracking-[0.2em]">{presentation?.label}</span>
      </div>
    </div>
  );
}
