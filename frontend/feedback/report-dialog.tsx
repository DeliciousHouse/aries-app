'use client';

/**
 * Customer incident report dialog (SC-70 port) — shared by authenticated and
 * anonymous visitors. Impact is asked FIRST (required, no default), then
 * category, title, description, and an optional screenshot via an in-page
 * capture of the current page (see capture-screenshot.ts — AA-77) or a file
 * picker.
 *
 * Outcome UX (SC-70): 201 → success with the Jira ticket link (plus
 * "attachment still syncing" / screenshot-discarded notes); 202 → "received —
 * syncing"; 429 → server message with the dialog kept open and values intact;
 * network/5xx → generic failure, dialog stays open, retry works. The submit
 * button is disabled while a request is in flight (exactly one POST).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Camera, Loader2, Paperclip, X } from 'lucide-react';

import {
  FEEDBACK_IMPACT_OPTIONS,
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SCREENSHOT_MIMES,
  type FeedbackImpact,
  type FeedbackReportCategory,
} from '@/lib/feedback/report-options';
import {
  buildReportSubmitBody,
  outcomeFromResponse,
  screenshotPayloadFromDataUrl,
  validateReportForm,
  type ReportOutcome,
  type ReportScreenshotPayload,
} from './report-form';
import { CAPTURE_IGNORE_ATTR, capturePageScreenshot, pageCaptureSupported } from './capture-screenshot';
import { cn } from '../donor/lib/utils';

type Phase = 'idle' | 'submitting' | 'success';

const CATEGORY_OPTIONS: Array<{ value: FeedbackReportCategory; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

interface ScreenshotState {
  payload: ReportScreenshotPayload;
  previewUrl: string;
  label: string;
}

export default function ReportModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const titleId = useId();
  const impactLegendId = useId();
  const categoryId = useId();
  const reportTitleId = useId();
  const descriptionId = useId();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  const [impact, setImpact] = useState<FeedbackImpact | null>(null);
  const [category, setCategory] = useState<FeedbackReportCategory>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState<ScreenshotState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReportOutcome | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [capturing, setCapturing] = useState(false);

  const submitting = phase === 'submitting';

  // Escape closes (unless mid-submit); Tab is trapped within the dialog.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && phase !== 'submitting') {
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
  }, [onClose, phase]);

  // Return focus to the trigger on close.
  useEffect(() => {
    previouslyFocusedRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  const attachDataUrl = useCallback((dataUrl: string, label: string) => {
    setScreenshotError(null);
    const result = screenshotPayloadFromDataUrl(dataUrl);
    if (!result.ok) {
      setScreenshotError(result.error);
      return;
    }
    setScreenshot({ payload: result.payload, previewUrl: dataUrl, label });
  }, []);

  const onPickFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (!file) return;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        attachDataUrl(dataUrl, file.name);
      } catch {
        setScreenshotError('That image could not be read.');
      }
    },
    [attachDataUrl],
  );

  const onCaptureScreen = useCallback(async () => {
    setCapturing(true);
    setScreenshotError(null);
    try {
      const dataUrl = await capturePageScreenshot();
      if (dataUrl) {
        attachDataUrl(dataUrl, 'Page capture');
      } else {
        // No picker/denial anymore, so a null is a genuine failure — point the
        // user at the always-available file picker rather than failing silently.
        setScreenshotError("We couldn't capture the page automatically — attach an image instead.");
      }
    } finally {
      setCapturing(false);
    }
  }, [attachDataUrl]);

  const clearScreenshot = useCallback(() => {
    setScreenshot(null);
    setScreenshotError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const resetForm = useCallback(() => {
    setImpact(null);
    setCategory('bug');
    setTitle('');
    setDescription('');
    setScreenshot(null);
    setScreenshotError(null);
    setFieldErrors({});
  }, []);

  const submit = useCallback(async () => {
    if (submitting || phase === 'success') return;

    const errors = validateReportForm({ impact, category, title, description });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return; // validation blocks the POST

    setPhase('submitting');
    setOutcome(null);
    try {
      const response = await fetch('/api/feedback/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          buildReportSubmitBody({ impact, category, title, description }, screenshot?.payload ?? null),
        ),
      });
      let data: Record<string, unknown> | null = null;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        data = null;
      }
      const mapped = outcomeFromResponse(response.status, data);
      setOutcome(mapped);
      if (mapped.kind === 'success' || mapped.kind === 'received') {
        setPhase('success');
        resetForm();
        // Long enough to read the confirmation / click the ticket link.
        window.setTimeout(onClose, 6000);
      } else {
        // 429 / errors: dialog stays open, values intact, retry works.
        setPhase('idle');
      }
    } catch {
      setOutcome({
        kind: 'error',
        message: "We couldn't reach the server. Check your connection and try again.",
      });
      setPhase('idle');
    }
  }, [category, description, impact, onClose, phase, resetForm, screenshot, submitting, title]);

  return (
    <div
      role="presentation"
      // Exclude the whole modal (backdrop + dialog) from an in-page capture so a
      // "Capture page" shot shows the page behind the dialog, not our own UI.
      {...{ [CAPTURE_IGNORE_ATTR]: '' }}
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
              Report an issue
            </h2>
            <p className="mt-0.5 text-xs text-white/55">
              No sign-in required. Signed-in users can receive an email follow-up.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close report dialog"
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
          <fieldset aria-labelledby={impactLegendId} data-testid="report-impact">
            <legend id={impactLegendId} className="mb-1.5 block text-sm font-medium text-white/85">
              How badly does this affect you? <span className="text-aries-crimson">*</span>
            </legend>
            <div className="space-y-1.5">
              {FEEDBACK_IMPACT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors',
                    impact === option.value
                      ? 'border-aries-crimson/60 bg-aries-crimson/10 text-white'
                      : 'border-white/10 bg-white/[0.03] text-white/70 hover:border-white/25 hover:text-white/90',
                    submitting && 'pointer-events-none opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="report-impact"
                    value={option.value}
                    checked={impact === option.value}
                    onChange={() => setImpact(option.value)}
                    disabled={submitting}
                    className="h-3.5 w-3.5 accent-[#c23550]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {fieldErrors.impact ? (
              <p className="mt-1 text-xs text-rose-300">{fieldErrors.impact}</p>
            ) : null}
          </fieldset>

          <div>
            <label htmlFor={categoryId} className="mb-1.5 block text-sm font-medium text-white/85">
              Category
            </label>
            <select
              id={categoryId}
              value={category}
              onChange={(event) => setCategory(event.target.value as FeedbackReportCategory)}
              disabled={submitting}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-[#0c0d12]">
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={reportTitleId} className="mb-1.5 block text-sm font-medium text-white/85">
              Title <span className="text-aries-crimson">*</span>
            </label>
            <input
              id={reportTitleId}
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={FEEDBACK_REPORT_LIMITS.titleMax}
              disabled={submitting}
              placeholder="One line summarizing the problem"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
            />
            {fieldErrors.title ? (
              <p className="mt-1 text-xs text-rose-300">{fieldErrors.title}</p>
            ) : null}
          </div>

          <div>
            <label htmlFor={descriptionId} className="mb-1.5 block text-sm font-medium text-white/85">
              What happened? <span className="text-aries-crimson">*</span>
            </label>
            <textarea
              id={descriptionId}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={FEEDBACK_REPORT_LIMITS.descriptionMax}
              rows={4}
              disabled={submitting}
              placeholder="What did you do, what did you expect, what happened instead?"
              className="w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
            />
            {fieldErrors.description ? (
              <p className="mt-1 text-xs text-rose-300">{fieldErrors.description}</p>
            ) : null}
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
                <span className="flex-1 truncate text-xs text-white/70">{screenshot.label}</span>
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
              <div className="flex flex-col gap-2 sm:flex-row">
                {pageCaptureSupported() ? (
                  <button
                    type="button"
                    onClick={() => void onCaptureScreen()}
                    disabled={submitting || capturing}
                    data-testid="report-capture-screen"
                    className={cn(
                      'flex flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-3 py-2.5 text-sm text-white/60',
                      'transition-colors hover:border-white/30 hover:text-white/80 disabled:opacity-60',
                    )}
                  >
                    {capturing ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Camera className="h-4 w-4" aria-hidden="true" />
                    )}
                    {capturing ? 'Capturing…' : 'Capture page'}
                  </button>
                ) : null}
                <label
                  className={cn(
                    'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-3 py-2.5 text-sm text-white/60',
                    'transition-colors hover:border-white/30 hover:text-white/80',
                    submitting && 'pointer-events-none opacity-60',
                  )}
                >
                  <Paperclip className="h-4 w-4" aria-hidden="true" />
                  Attach an image
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={FEEDBACK_REPORT_SCREENSHOT_MIMES.join(',')}
                    onChange={(event) => void onPickFile(event)}
                    disabled={submitting}
                    className="sr-only"
                  />
                </label>
              </div>
            )}
            {screenshotError ? (
              <p className="mt-1 text-xs text-rose-300">{screenshotError}</p>
            ) : null}
          </div>

          <div>
            {outcome && (outcome.kind === 'error' || outcome.kind === 'rate_limited') ? (
              <p
                role="alert"
                className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-sm text-rose-100"
              >
                {outcome.message}
              </p>
            ) : null}
            {outcome && (outcome.kind === 'success' || outcome.kind === 'received') ? (
              <p
                role="status"
                className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100"
              >
                {outcome.message}
                {outcome.kind === 'success' && outcome.ticketUrl ? (
                  <>
                    {' '}
                    <a
                      href={outcome.ticketUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold underline underline-offset-2 hover:text-white"
                    >
                      View {outcome.ticketKey}
                    </a>
                  </>
                ) : null}
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
              {phase === 'success' ? 'Close' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={submitting || phase === 'success'}
              data-testid="report-submit"
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
              ) : outcome?.kind === 'error' ? (
                'Retry'
              ) : (
                'Send report'
              )}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
