'use client';

/**
 * Floating feedback widget — mounted once in the root layout so it appears on
 * every page, authenticated or not (spec §4). A bottom-right button opens a
 * lightweight modal: comment + category + optional screenshot (severity is
 * inferred server-side, not asked of the user). On
 * submit it captures page/browser/console context and POSTs to /api/feedback.
 *
 * Failure preserves the user's input and offers a retry (spec §9.6); success
 * shows a confirmation and closes.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Loader2, MessageSquarePlus, Paperclip, X } from 'lucide-react';

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
  FEEDBACK_SCREENSHOT_MIME_TYPES,
  type FeedbackCategory,
} from '@/lib/feedback/options';
import { cn } from '../donor/lib/utils';
import { getRecentConsoleErrors, installConsoleCapture } from './console-capture';

type Phase = 'idle' | 'submitting' | 'success' | 'error';

function newSubmissionId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `fb_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

function captureContext(): {
  pageUrl: string | null;
  userAgent: string | null;
  viewport: string | null;
  consoleErrors: string[];
} {
  if (typeof window === 'undefined') {
    return { pageUrl: null, userAgent: null, viewport: null, consoleErrors: [] };
  }
  return {
    pageUrl: window.location?.href ?? null,
    userAgent: window.navigator?.userAgent ?? null,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    consoleErrors: getRecentConsoleErrors(),
  };
}

const isDisabled = process.env.NEXT_PUBLIC_FEEDBACK_DISABLED === 'true' || process.env.NEXT_PUBLIC_FEEDBACK_DISABLED === '1';

export default function FeedbackWidget(): React.ReactElement | null {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    installConsoleCapture();
  }, []);

  if (isDisabled) return null;

  return (
    <>
      {/* Always mounted (hidden from a11y + tab order while the modal is open) so
          focus can return to it when the modal closes. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Send feedback"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
        data-testid="feedback-button"
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
            {open && <FeedbackModal onClose={() => setOpen(false)} />}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

function FeedbackModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const titleId = useId();
  const commentId = useId();
  const categoryId = useId();
  const statusId = useId();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Stable across retries → server upserts instead of duplicating (idempotency).
  const submissionIdRef = useRef<string>(newSubmissionId());
  const reduceMotion = useReducedMotion();

  const [comment, setComment] = useState('');
  const [category, setCategory] = useState<FeedbackCategory>(FEEDBACK_CATEGORIES[0]);
  const [screenshot, setScreenshot] = useState<{ file: File; previewUrl: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submitting = phase === 'submitting';
  const commentValid = comment.trim().length > 0;

  // Escape closes (unless mid-submit); Tab is trapped within the dialog so focus
  // can't escape to the page behind the modal.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // Focus the comment field on open; return focus to the trigger on close.
  useEffect(() => {
    previouslyFocusedRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    commentRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  // Revoke the object URL when the screenshot changes/unmounts.
  useEffect(() => {
    return () => {
      if (screenshot?.previewUrl) URL.revokeObjectURL(screenshot.previewUrl);
    };
  }, [screenshot?.previewUrl]);

  const onPickFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    setErrorMessage(null);
    if (!(FEEDBACK_SCREENSHOT_MIME_TYPES as readonly string[]).includes(file.type)) {
      setErrorMessage('Screenshot must be a PNG, JPEG, WebP, or GIF image.');
      return;
    }
    if (file.size > FEEDBACK_LIMITS.screenshotBytesMax) {
      setErrorMessage('Screenshot must be 5 MB or smaller.');
      return;
    }
    setScreenshot((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return { file, previewUrl: URL.createObjectURL(file) };
    });
  }, []);

  const clearScreenshot = useCallback(() => {
    setScreenshot((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const submit = useCallback(async () => {
    if (!commentValid || submitting) return;
    setPhase('submitting');
    setErrorMessage(null);

    try {
      let screenshotPayload: string | null = null;
      if (screenshot) {
        try {
          screenshotPayload = await readFileAsDataUrl(screenshot.file);
        } catch {
          screenshotPayload = null; // proceed without the image rather than blocking
        }
      }

      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId: submissionIdRef.current,
          comment: comment.trim(),
          category,
          context: captureContext(),
          screenshot: screenshotPayload,
        }),
      });

      let data: {
        error?: string;
        fieldErrors?: Record<string, string>;
        submissionId?: string;
      } = {};
      try {
        data = await response.json();
      } catch {
        // ignore non-JSON bodies
      }
      // Adopt the server's submission id so a retry stays idempotent even if the
      // server minted/normalized a different one.
      if (typeof data.submissionId === 'string') submissionIdRef.current = data.submissionId;

      if (response.ok) {
        setPhase('success');
        // Long enough for a screen reader to announce the confirmation.
        window.setTimeout(onClose, 3000);
        return;
      }

      const reason =
        data.fieldErrors?.comment ?? data.fieldErrors?.screenshot ?? data.error ?? 'unknown';
      setErrorMessage(messageForError(reason, response.status));
      setPhase('error');
    } catch {
      setErrorMessage("We couldn't reach the server. Check your connection and try again.");
      setPhase('error');
    }
  }, [category, comment, commentValid, onClose, screenshot, submitting]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[200] flex items-end justify-center overflow-y-auto p-4 sm:items-center"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={() => !submitting && onClose()}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
      />

      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
        transition={{ duration: 0.18 }}
        className={cn(
          'relative z-10 my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl',
          'border border-white/10 bg-[#0c0d12]/95 shadow-[0_32px_120px_rgba(0,0,0,0.6)] backdrop-blur-xl',
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-white">
              Send feedback
            </h2>
            <p className="mt-0.5 text-xs text-white/55">
              Tell us what happened — we capture the page and tech details automatically.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close feedback"
            className="rounded-full p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex-1 space-y-4 overflow-y-auto px-5 py-4"
        >
          <div>
            <label htmlFor={commentId} className="mb-1.5 block text-sm font-medium text-white/85">
              Comment <span className="text-aries-crimson">*</span>
            </label>
            <textarea
              id={commentId}
              ref={commentRef}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={FEEDBACK_LIMITS.commentMax}
              required
              rows={4}
              disabled={submitting}
              placeholder="Describe the issue or idea…"
              className="w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
            />
          </div>

          <div>
            <label htmlFor={categoryId} className="mb-1.5 block text-sm font-medium text-white/85">
              Category
            </label>
            <select
              id={categoryId}
              value={category}
              onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
              disabled={submitting}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
            >
              {FEEDBACK_CATEGORIES.map((value) => (
                <option key={value} value={value} className="bg-[#0c0d12]">
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-white/85">
              Screenshot <span className="font-normal text-white/45">(optional)</span>
            </span>
            {screenshot ? (
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot.previewUrl}
                  alt="Screenshot preview"
                  className="h-12 w-12 rounded-lg object-cover"
                />
                <span className="flex-1 truncate text-xs text-white/70">{screenshot.file.name}</span>
                <button
                  type="button"
                  onClick={clearScreenshot}
                  disabled={submitting}
                  className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            ) : (
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-3 py-2.5 text-sm text-white/60',
                  'transition-colors hover:border-white/30 hover:text-white/80',
                  submitting && 'pointer-events-none opacity-60',
                )}
              >
                <Paperclip className="h-4 w-4" aria-hidden="true" />
                Attach a screenshot
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={FEEDBACK_SCREENSHOT_MIME_TYPES.join(',')}
                  onChange={onPickFile}
                  disabled={submitting}
                  className="sr-only"
                />
              </label>
            )}
          </div>

          {/* No aria-live here: the child role="alert"/role="status" are their own
              live regions; wrapping them would double-announce. */}
          <div id={statusId}>
            {phase === 'error' && errorMessage ? (
              <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
                {errorMessage}
              </p>
            ) : null}
            {phase === 'success' ? (
              <p role="status" className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
                Thanks — your feedback was sent.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-full px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!commentValid || submitting || phase === 'success'}
              data-testid="feedback-submit"
              className={cn(
                'inline-flex items-center gap-2 rounded-full bg-aries-crimson px-5 py-2 text-sm font-semibold text-white',
                'shadow-[0_0_20px_rgba(194,53,80,0.3)] transition-all hover:bg-[#d8475f]',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Sending…
                </>
              ) : phase === 'error' ? (
                'Retry'
              ) : (
                'Send feedback'
              )}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function messageForError(reason: string, status: number): string {
  if (reason === 'A comment is required.' || reason === 'invalid_input') {
    return 'Please add a comment before sending.';
  }
  if (reason === 'screenshot_too_large') return 'Screenshot must be 5 MB or smaller.';
  if (reason === 'screenshot_unsupported_type') return 'That image type is not supported.';
  if (reason === 'rate_limited' || status === 429) {
    return 'Too many submissions right now. Please try again shortly.';
  }
  if (reason === 'feedback_disabled') return 'Feedback is temporarily unavailable.';
  // sheet_sync_failed / persist_failed / unknown — all retryable.
  return "We couldn't send that just now. Your text is saved — please retry.";
}
