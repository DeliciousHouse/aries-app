import type { HTMLAttributes, ReactNode } from 'react';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

export function Badge({ children, className, ...props }: BadgeProps): JSX.Element {
  return (
    <span className={['rd-badge', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </span>
  );
}
