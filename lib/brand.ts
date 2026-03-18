export const ARIES_LOGO_WEBP_PATH = '/aries.webp';
export const ARIES_FAVICON_SVG_PATH = '/favicon.svg';
export const ARIES_FAVICON_PNG_PATH = '/favicon.png';
export const ARIES_FAVICON_ICO_PATH = '/favicon.ico';

export function brandLogoPath(preferRaster = true): string {
  return preferRaster ? ARIES_LOGO_WEBP_PATH : ARIES_FAVICON_SVG_PATH;
}
