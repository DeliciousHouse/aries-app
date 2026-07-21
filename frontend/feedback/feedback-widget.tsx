'use client';

/**
 * Floating feedback widget — mounted once in the root layout so it appears on
 * every page, authenticated or not (spec §4). Every visitor opens the durable
 * incident-report modal and POSTs to /api/feedback/submit; the server enriches
 * authenticated sessions and rate-limits anonymous visitors by hashed IP.
 *
 * Failure preserves the user's input and offers a retry (spec §9.6); success
 * shows a confirmation and closes.
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { MessageSquarePlus } from 'lucide-react';

import { cn } from '../donor/lib/utils';
import { CAPTURE_IGNORE_ATTR } from './capture-screenshot';
import { installConsoleCapture } from './console-capture';
import ReportModal from './report-dialog';

const isDisabled = process.env.NEXT_PUBLIC_FEEDBACK_DISABLED === 'true' || process.env.NEXT_PUBLIC_FEEDBACK_DISABLED === '1';

export default function FeedbackWidget(): React.ReactElement | null {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    installConsoleCapture();
  }, []);

  const openDialog = useCallback(() => {
    setOpen(true);
  }, []);

  if (isDisabled) return null;

  return (
    <>
      {/* Always mounted (hidden from a11y + tab order while the modal is open) so
          focus can return to it when the modal closes. */}
      <button
        type="button"
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-label="Send feedback"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
        data-testid="feedback-button"
        // Kept out of an in-page "Capture page" shot (it's still in the DOM,
        // just visually hidden, while the report modal is open).
        {...{ [CAPTURE_IGNORE_ATTR]: '' }}
        className={cn(
          'fixed bottom-4 right-4 z-[120] flex items-center gap-2 rounded-full',
          'bg-aries-crimson px-4 py-3 text-sm font-semibold text-white shadow-lg',
          'shadow-[0_8px_30px_rgba(194,53,80,0.35)] ring-1 ring-white/15 backdrop-blur',
          'transition-transform hover:-translate-y-0.5 hover:bg-[#d8475f]',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
          'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
          'sm:bottom-6 sm:right-6',
          open && 'pointer-events-none opacity-0',
        )}
      >
        <MessageSquarePlus className="h-5 w-5" aria-hidden="true" />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      {mounted &&
        typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open ? <ReportModal onClose={() => setOpen(false)} /> : null}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
