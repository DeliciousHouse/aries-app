import type { CSSProperties } from 'react';

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
        'rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center font-bold text-white border border-white/20 shadow-lg shadow-primary/20',
        sizeClassName,
        className,
      )}
      style={style}
      aria-hidden="true"
    >
      A
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
