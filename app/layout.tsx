import type { Metadata } from 'next';
import { Ubuntu, Ubuntu_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';
import { ARIES_FAVICON_ICO_PATH, ARIES_FAVICON_PNG_PATH, ARIES_LOGO_WEBP_PATH } from '@/lib/brand';

const ubuntu = Ubuntu({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-ubuntu-title',
});

const ubuntuMono = Ubuntu_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-ubuntu-body',
});

export const metadata: Metadata = {
  title: 'Aries OS',
  description: 'Aries OS unifies Ops, Brain, and Lab inside a truthful production shell backed by local filesystem contracts.',
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
      <body className={`${ubuntu.variable} ${ubuntuMono.variable}`}>{children}</body>
    </html>
  );
}
