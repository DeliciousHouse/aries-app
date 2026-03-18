import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  title,
  description,
  action,
}: EmptyStateProps): JSX.Element {
  return (
    <div className="rd-empty">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
