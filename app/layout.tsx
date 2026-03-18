import type { ReactNode } from 'react';
import './globals.css';
import { ARIES_FAVICON_ICO_PATH, ARIES_FAVICON_PNG_PATH, ARIES_LOGO_WEBP_PATH } from '@/lib/brand';

export const metadata = {
  title: 'Aries AI — Next-Generation LLM-Powered Agent',
  description: 'Sophisticated reasoning and seamless integrations for your most demanding tasks. Multi-platform publishing, AI-driven marketing, and intelligent automation.',
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
