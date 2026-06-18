/**
 * PlatformIcon — maps a Platform value to the correct icon component.
 *
 * Brand icons (Facebook/Instagram/LinkedIn/YouTube) come from brand-icons.tsx
 * (inline SVGs added when lucide-react v1 dropped brand glyphs).
 * X and Reddit come from frontend/components/Icons.tsx.
 *
 * The `size` prop is passed as the `size` attribute to BrandIcon components
 * and as `width`/`height` to the SVGProps-based X and Reddit icons.
 */

import type { Platform } from '@/backend/insights/platforms/registry';
import { FacebookIcon, InstagramIcon, LinkedinIcon, YoutubeIcon } from './brand-icons';
import { RedditIcon, XIcon } from '@/frontend/components/Icons';

export function PlatformIcon({
  platform,
  size = 16,
  className,
}: {
  platform: Platform;
  size?: number;
  className?: string;
}) {
  switch (platform) {
    case 'facebook':
      return <FacebookIcon size={size} className={className} />;
    case 'instagram':
      return <InstagramIcon size={size} className={className} />;
    case 'linkedin':
      return <LinkedinIcon size={size} className={className} />;
    case 'youtube':
      return <YoutubeIcon size={size} className={className} />;
    case 'reddit':
      return <RedditIcon width={size} height={size} className={className} />;
    case 'x':
      return <XIcon width={size} height={size} className={className} />;
  }
}
