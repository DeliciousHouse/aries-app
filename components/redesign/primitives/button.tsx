import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

function classesFor(variant: ButtonVariant, className?: string) {
  const base = ['rd-button', `rd-button--${variant}`, className].filter(Boolean).join(' ');
  return base;
}

interface SharedProps {
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
}

type ButtonProps = SharedProps & ButtonHTMLAttributes<HTMLButtonElement>;
type ButtonLinkProps = SharedProps & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export function Button({
  children,
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button type={type} className={classesFor(variant, className)} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  variant = 'primary',
  className,
  href,
  ...props
}: ButtonLinkProps): JSX.Element {
  return (
    <a href={href} className={classesFor(variant, className)} {...props}>
      {children}
    </a>
  );
}
