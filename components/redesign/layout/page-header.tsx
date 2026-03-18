import type { ReactNode } from 'react';

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps): JSX.Element {
  return (
    <header className="rd-page-header">
      <div>
        {eyebrow ? <p className="rd-hero__eyebrow">{eyebrow}</p> : null}
        <h1 className="rd-page-header__title">{title}</h1>
        {description ? <p className="rd-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="rd-inline-actions">{actions}</div> : null}
    </header>
  );
}
