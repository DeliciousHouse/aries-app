import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { ARIES_FAVICON_ICO_PATH, ARIES_FAVICON_PNG_PATH, ARIES_LOGO_WEBP_PATH, ARIES_OG_IMAGE_PATH } from '@/lib/brand';
import { metadataSiteOrigin } from '@/lib/metadata-site-url';
import FeedbackWidget from '@/frontend/feedback/feedback-widget';
import { resolveFeedbackConfig } from '@/lib/feedback/feedback-config';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-inter',
});

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  display: 'swap',
  variable: '--font-manrope',
});

const SITE_TITLE = 'Aries AI - Weekly Social Content Operating System';
const SITE_DESCRIPTION =
  'A premium, approval-safe social content operating system for small businesses. Plan weekly posts, approve creative, publish safely, and see what worked.';
const OG_IMAGE = {
  url: ARIES_OG_IMAGE_PATH,
  width: 1200,
  height: 630,
  alt: 'Aries AI - Weekly Social Content Operating System',
};

// Page titles already carry their own "— Aries AI" suffix, so the template adds nothing.
export const viewport: Viewport = {
  themeColor: '#050505', // --color-background in app/globals.css
};

export const metadata: Metadata = {
  metadataBase: new URL(metadataSiteOrigin()),
  title: { default: SITE_TITLE, template: '%s' },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: 'Aries AI',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
  icons: {
    icon: [
      { url: ARIES_FAVICON_ICO_PATH, type: 'image/x-icon' },
      { url: ARIES_FAVICON_PNG_PATH, type: 'image/png' },
      { url: ARIES_LOGO_WEBP_PATH, type: 'image/webp' },
    ],
    shortcut: ARIES_FAVICON_ICO_PATH,
    apple: ARIES_FAVICON_PNG_PATH,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${manrope.variable}`}>
        {children}
        {/* Server-side FEEDBACK_ENABLED gate so the kill switch hides the button
            (not just the API). The client NEXT_PUBLIC_FEEDBACK_DISABLED is a
            build-time override layered on top. */}
        {resolveFeedbackConfig().enabled ? <FeedbackWidget /> : null}
      </body>
    </html>
  );
}
