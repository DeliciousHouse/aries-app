import type { HTMLAttributes, ReactNode } from 'react';

type AlertTone = 'info' | 'success' | 'danger';

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: AlertTone;
}

export function Alert({
  children,
  tone = 'info',
  className,
  ...props
}: AlertProps): JSX.Element {
  return (
    <div className={['rd-alert', `rd-alert--${tone}`, className].filter(Boolean).join(' ')} {...props}>
      {children}
    </div>
  );
}
