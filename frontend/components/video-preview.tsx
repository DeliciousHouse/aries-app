'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Archive, Loader2 } from 'lucide-react';

type VideoPreviewProps = {
  src?: string | null;
  poster?: string | null;
  className?: string;
};

export default function VideoPreview({ src, poster, className }: VideoPreviewProps) {
  const [loading, setLoading] = useState(Boolean(src));
  const [failed, setFailed] = useState(false);

  // Reset transient state when the src changes, so a prior failure or a
  // null→src transition doesn't leave the component stuck on "Preview
  // archived" or skip the loading overlay. Without this, navigating
  // between two campaigns whose media-preview shares a mounted instance
  // would show stale state from the first one.
  useEffect(() => {
    setFailed(false);
    setLoading(Boolean(src));
  }, [src]);

  const fallback = useMemo(() => {
    if (!src) {
      return { label: 'Preview pending', icon: 'alert' as const };
    }
    // Same reasoning as media-preview.tsx: a 404 on a real src for an older
    // campaign almost always means the asset aged out of the Hermes cache.
    // "Preview archived" reads as intentional retention, "Preview unavailable"
    // reads as a bug.
    return failed ? { label: 'Preview archived', icon: 'archive' as const } : null;
  }, [failed, src]);

  if (fallback) {
    return (
      <div className={`${className ?? ''} flex items-center justify-center bg-black/30 text-white/55`}>
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          {fallback.icon === 'archive' ? <Archive className="h-6 w-6" /> : <AlertCircle className="h-6 w-6" />}
          <span className="text-xs font-medium uppercase tracking-[0.2em]">{fallback.label}</span>
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
