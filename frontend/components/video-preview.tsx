'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

type VideoPreviewProps = {
  src?: string | null;
  poster?: string | null;
  className?: string;
};

export default function VideoPreview({ src, poster, className }: VideoPreviewProps) {
  const [loading, setLoading] = useState(Boolean(src));
  const [failed, setFailed] = useState(false);

  const fallbackLabel = useMemo(() => {
    if (!src) {
      return 'Preview pending';
    }
    return failed ? 'Preview unavailable' : null;
  }, [failed, src]);

  if (fallbackLabel) {
    return (
      <div className={`${className ?? ''} flex items-center justify-center bg-black/30 text-white/55`}>
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          <AlertCircle className="h-6 w-6" />
          <span className="text-xs font-medium uppercase tracking-[0.2em]">{fallbackLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-black">
      {loading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 text-white/70">
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">Loading preview</span>
          </div>
        </div>
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        controls
        preload="metadata"
        poster={poster ?? undefined}
        src={src ?? undefined}
        playsInline
        className={className ?? 'h-full w-full object-contain bg-black'}
        onLoadedMetadata={() => {
          setLoading(false);
          setFailed(false);
        }}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
      />
    </div>
  );
}
