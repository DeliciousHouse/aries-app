/**
 * Inline SVG brand icons for Facebook and Instagram.
 *
 * lucide-react v1 dropped all brand icons. These drop-in replacements match
 * lucide's API surface (size, className, strokeWidth, aria-hidden) so the
 * four files that used <Facebook/> / <Instagram/> from lucide only need an
 * import swap and a component rename.
 */

import type { SVGProps } from 'react';

interface BrandIconProps extends SVGProps<SVGSVGElement> {
  /** Icon size in px — mirrors lucide's `size` prop. Defaults to 24. */
  size?: number | string;
}

export function FacebookIcon({ size = 24, className, strokeWidth: _sw, ...rest }: BrandIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {/* Facebook "f" wordmark glyph */}
      <path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987H7.898V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" />
    </svg>
  );
}

export function InstagramIcon({ size = 24, className, strokeWidth: _sw, ...rest }: BrandIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {/* Instagram camera glyph */}
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.334 3.608 1.308.975.975 1.246 2.242 1.308 3.608.058 1.266.07 1.646.07 4.85s-.012 3.584-.07 4.85c-.062 1.366-.333 2.633-1.308 3.608-.975.975-2.242 1.246-3.608 1.308-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.366-.062-2.633-.333-3.608-1.308-.975-.975-1.246-2.242-1.308-3.608C2.175 15.584 2.163 15.204 2.163 12s.012-3.584.07-4.85c.062-1.366.333-2.633 1.308-3.608C4.516 2.497 5.783 2.226 7.15 2.163 8.416 2.105 8.796 2.163 12 2.163zm0-2.163C8.741 0 8.333.014 7.053.072 5.77.131 4.577.414 3.55 1.44 2.522 2.468 2.239 3.661 2.18 4.944 2.122 6.224 2.163 6.632 2.163 12c0 5.368.014 5.776.072 7.056.059 1.283.342 2.476 1.368 3.503 1.028 1.027 2.221 1.31 3.504 1.369C8.224 23.986 8.632 24 12 24c3.368 0 3.776-.014 5.056-.072 1.283-.059 2.476-.342 3.503-1.369 1.027-1.027 1.31-2.22 1.369-3.503.058-1.28.072-1.688.072-7.056 0-5.368-.014-5.776-.072-7.056-.059-1.283-.342-2.476-1.369-3.503C19.532.414 18.339.131 17.056.072 15.776.014 15.368 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zm0 10.162a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
    </svg>
  );
}
