import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className, ...props }: CardProps): JSX.Element {
  return (
    <div className={['rd-card', className].filter(Boolean).join(' ')} {...props}>
      <div className="rd-card__body">{children}</div>
    </div>
  );
}
