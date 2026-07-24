'use client';

import type { JSX } from 'react';

/**
 * Last-resort boundary: catches errors thrown by the root layout itself, where
 * app/error.tsx cannot mount. It must render its own <html>/<body>, and it
 * cannot rely on the app's providers or global CSS having loaded — so the
 * styling here is deliberately inline and self-contained rather than reusing
 * ErrorSurface.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): JSX.Element {
  const reference = error.digest?.trim() || 'unavailable';

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#08070b',
          color: '#ffffff',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <p
            style={{
              fontSize: '0.75rem',
              letterSpacing: '0.35em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.7)',
              margin: 0,
            }}
          >
            Unexpected error
          </p>
          <h1 style={{ fontSize: '2rem', fontWeight: 400, letterSpacing: '-0.04em', margin: '1rem 0 0' }}>
            Aries could not load this page
          </h1>
          <p style={{ margin: '1rem 0 0', fontSize: '0.875rem', lineHeight: 1.75, color: 'rgba(255,255,255,0.65)' }}>
            This is a fault on our side. Quote the reference below to support and we can trace it.
          </p>

          <div
            style={{
              margin: '2rem 0 0',
              padding: '1.25rem',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.04)',
              borderRadius: '1rem',
              textAlign: 'left',
            }}
          >
            <p
              style={{
                fontSize: '0.7rem',
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.4)',
                margin: 0,
              }}
            >
              Reference
            </p>
            <code
              style={{
                display: 'block',
                marginTop: '0.5rem',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.875rem',
                userSelect: 'all',
                wordBreak: 'break-all',
              }}
            >
              {reference}
            </code>
          </div>

          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                borderRadius: '9999px',
                border: 'none',
                background: '#ffffff',
                color: '#000000',
                padding: '0.625rem 1.5rem',
                fontSize: '0.875rem',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                borderRadius: '9999px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.05)',
                color: '#ffffff',
                padding: '0.625rem 1.5rem',
                fontSize: '0.875rem',
                textDecoration: 'none',
              }}
            >
              Back to home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
