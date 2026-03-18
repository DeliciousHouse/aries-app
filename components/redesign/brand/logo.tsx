import Image from 'next/image';

import { ARIES_FAVICON_SVG_PATH, ARIES_LOGO_WEBP_PATH } from '@/lib/brand';

export interface BrandLogoProps {
  size?: number;
  alt?: string;
  variant?: 'mark' | 'lockup';
  className?: string;
  priority?: boolean;
}

export function BrandLogo({
  size = 48,
  alt = 'Aries AI',
  variant = 'lockup',
  className,
  priority = false,
}: BrandLogoProps): JSX.Element {
  const mark = (
    <span
      className={['rd-brand__mark', className].filter(Boolean).join(' ')}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius: Math.max(14, Math.round(size * 0.32)),
        overflow: 'hidden',
        padding: Math.max(4, Math.round(size * 0.16)),
      }}
      aria-hidden={variant === 'mark' ? undefined : true}
    >
      <Image
        src={ARIES_LOGO_WEBP_PATH}
        alt={alt}
        width={size}
        height={size}
        priority={priority}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </span>
  );

  if (variant === 'mark') {
    return mark;
  }

  return (
    <span className={['rd-brand', className].filter(Boolean).join(' ')}>
      {mark}
      <span style={{ display: 'grid', gap: 2 }}>
        <span>Aries AI</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--rd-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Operator Runtime
        </span>
      </span>
    </span>
  );
}

export function BrandLogoFallbackSvg({
  size = 48,
  alt = 'Aries AI',
}: Pick<BrandLogoProps, 'size' | 'alt'>): JSX.Element {
  return (
    <Image
      src={ARIES_FAVICON_SVG_PATH}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}
