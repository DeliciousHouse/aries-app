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
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
      }}
      aria-hidden={variant === 'mark' ? undefined : true}
    >
      <Image
        src={ARIES_LOGO_WEBP_PATH}
        alt={alt}
        width={size}
        height={size}
        priority={priority}
        style={{ width: '100%', height: '100%', objectFit: 'contain', filter: 'drop-shadow(0 0 18px rgba(255,255,255,0.12))' }}
      />
    </span>
  );

  if (variant === 'mark') {
    return mark;
  }

  return (
    <span className={['rd-brand', className].filter(Boolean).join(' ')}>
      {mark}
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>Aries AI</span>
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
