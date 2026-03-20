import type { CSSProperties } from 'react';

import { cn } from './lib/utils';

export interface AriesMarkProps {
  className?: string;
  sizeClassName?: string;
  style?: CSSProperties;
}

export function AriesMark({ className, sizeClassName = 'w-20 h-20', style }: AriesMarkProps) {
  return (
    <img
      src="/ariesai-logo.webp"
      alt="Aries AI Logo"
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
