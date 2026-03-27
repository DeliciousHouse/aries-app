import React from 'react';
import type { CSSProperties } from 'react';
import Image from 'next/image';

import { ARIES_FAVICON_SVG_PATH } from '@/lib/brand';
import { cn } from './lib/utils';

export interface AriesMarkProps {
  className?: string;
  sizeClassName?: string;
  style?: CSSProperties;
}

export function AriesMark({ className, sizeClassName = 'w-8 h-8', style }: AriesMarkProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center justify-center overflow-hidden rounded-[24%] border border-white/14 bg-white/[0.04] p-[18%] shadow-[0_16px_38px_rgba(124,58,237,0.18)]',
        sizeClassName,
        className,
      )}
      style={style}
      aria-hidden="true"
    >
      <Image
        src={ARIES_FAVICON_SVG_PATH}
        alt=""
        width={256}
        height={256}
        className="h-full w-full object-contain"
      />
    </div>
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
