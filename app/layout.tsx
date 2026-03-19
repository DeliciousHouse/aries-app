import type { ReactNode } from 'react';
import { Inter, Manrope } from 'next/font/google';

import './globals.css';
import { ARIES_FAVICON_SVG_PATH } from '@/lib/brand';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
});

export const metadata = {
  title: 'Aries AI — Next-Generation LLM-Powered Agent',
  description: 'Sophisticated reasoning and seamless integrations for your most demanding tasks. Multi-platform publishing, AI-driven marketing, and intelligent automation.',
  icons: {
    icon: [{ url: ARIES_FAVICON_SVG_PATH, type: 'image/svg+xml' }],
    shortcut: ARIES_FAVICON_SVG_PATH,
    apple: '/favicon.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable}`}>
      <body>{children}</body>
    </html>
  );
}
