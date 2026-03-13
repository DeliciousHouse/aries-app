import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Aries AI — Next-Generation LLM-Powered Agent',
  description: 'Sophisticated reasoning and seamless integrations for your most demanding tasks. Multi-platform publishing, AI-driven marketing, and intelligent automation.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/aries.webp', type: 'image/webp' },
    ],
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
