import type { Metadata } from 'next';
import { Inter, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { ARIES_FAVICON_ICO_PATH, ARIES_FAVICON_PNG_PATH, ARIES_LOGO_WEBP_PATH } from '@/lib/brand';

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

export const metadata: Metadata = {
  title: 'Aries AI - Marketing Operating System',
  description: 'A premium, approval-safe marketing operating system for small businesses. Plan campaigns, approve creative, launch safely, and see what worked.',
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
      <body className={`${inter.variable} ${manrope.variable}`}>{children}</body>
    </html>
  );
}
