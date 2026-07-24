'use client';

import { type JSX, useEffect } from 'react';

import ErrorSurface from '@/frontend/errors/error-surface';

/**
 * Root route-segment error boundary. Before this existed, ANY uncaught server
 * exception (e.g. the brand-kit scrape throwing `brand_kit_fetch_failed` while
 * materializing a brand-new account) rendered Next's bare default error page
 * with no reference a user could quote back to support.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): JSX.Element {
  useEffect(() => {
    // Surface the digest in the browser console too, so a user on a support
    // call can read it out even after navigating away from the screen.
    console.error('[aries] unhandled error', { digest: error.digest, message: error.message });
  }, [error]);

  return <ErrorSurface error={error} reset={reset} />;
}
