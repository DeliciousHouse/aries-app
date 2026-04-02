import type { CSSProperties } from 'react';
import Image from 'next/image';

import { cn } from './lib/utils';

export interface AriesMarkProps {
  className?: string;
  sizeClassName?: string;
  sizes?: string;
  priority?: boolean;
  style?: CSSProperties;
}

export function AriesMark({
  className,
  sizeClassName = 'w-20 h-20',
  sizes = '80px',
  priority = false,
  style,
}: AriesMarkProps) {
  return (
    <Image
      src="/ariesai-logo.webp"
      alt="Aries AI Logo"
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
