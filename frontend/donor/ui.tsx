import type { CSSProperties } from 'react';
import Image from 'next/image';

import { cn } from './lib/utils';

export interface AriesMarkProps {
  className?: string;
  sizeClassName?: string;
  sizes?: string;
  priority?: boolean;
  style?: CSSProperties;
  /** Marks the image as decorative (alt=""). Use when an ancestor already
   *  provides the accessible name (e.g. a brand link with aria-label). */
  decorative?: boolean;
}

export function AriesMark({
  className,
  sizeClassName = 'w-20 h-20',
  sizes = '80px',
  priority = false,
  style,
  decorative = false,
}: AriesMarkProps) {
  // When an ancestor already provides the accessible name (e.g. a brand link
  // with aria-label="Aries AI — home"), callers pass `decorative` so this
  // image doesn't add a redundant announcement.
  return (
    <Image
      src="/ariesai-logo.webp"
      alt={decorative ? '' : 'Aries AI Logo'}
      width={500}
      height={500}
      sizes={sizes}
      priority={priority}
      className={cn('object-contain', sizeClassName, className)}
      style={style}
    />
  );
}

export interface AriesWordmarkProps {
  className?: string;
  markClassName?: string;
  labelClassName?: string;
}

export function AriesWordmark({
  className,
  markClassName,
  labelClassName,
}: AriesWordmarkProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <AriesMark className={markClassName} />
      <span className={cn('text-xl font-bold tracking-tight text-white', labelClassName)}>
        Aries AI
      </span>
    </div>
  );
}
