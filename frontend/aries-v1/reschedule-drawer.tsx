'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Check, Facebook, Instagram, LoaderCircle, X } from 'lucide-react';
import { format } from 'date-fns';

const DEFAULT_TIMEZONE = 'America/New_York';

const PLATFORM_OPTIONS = [
  { id: 'instagram' as const, label: 'Instagram', Icon: Instagram },
  { id: 'facebook' as const, label: 'Facebook', Icon: Facebook },
];

type PlatformId = (typeof PLATFORM_OPTIONS)[number]['id'];

export interface ScheduleSavedDetail {
  jobId: string;
  postId: string;
  scheduledAt: string;
  platforms: PlatformId[];
  updatedAt: string;
}

export interface RescheduleDrawerProps {
  jobId: string;
  postId: string;
  defaultScheduledAt?: string | null;
  defaultPlatforms?: PlatformId[];
  timezoneLabel?: string;
  onClose: () => void;
  onSaved?: (detail: ScheduleSavedDetail) => void;
  endpointBase?: string;
}

function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 60 - now.getMinutes());
    return format(now, "yyyy-MM-dd'T'HH:mm");
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return format(parsed, "yyyy-MM-dd'T'HH:mm");
}

export default function RescheduleDrawer(props: RescheduleDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const initialPlatforms = useMemo<Set<PlatformId>>(
    () => new Set(props.defaultPlatforms?.length ? props.defaultPlatforms : ['instagram', 'facebook']),
    [props.defaultPlatforms],
  );

  const [scheduledAtLocal, setScheduledAtLocal] = useState(() => toLocalInputValue(props.defaultScheduledAt));
  const [platforms, setPlatforms] = useState<Set<PlatformId>>(initialPlatforms);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) {
        props.onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props, submitting]);

  function togglePlatform(id: PlatformId) {
    setErrorMessage(null);
    setPlatforms((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (!scheduledAtLocal) {
      setErrorMessage('Pick a date and time before saving.');
      return;
    }
    const localDate = new Date(scheduledAtLocal);
    if (Number.isNaN(localDate.getTime())) {
      setErrorMessage('That date and time could not be read. Try again.');
      return;
    }
    const orderedPlatforms: PlatformId[] = PLATFORM_OPTIONS
      .map((option) => option.id)
      .filter((id) => platforms.has(id));
    if (orderedPlatforms.length === 0) {
      setErrorMessage('Pick at least one platform target.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setConfirmation(null);

    try {
      const base = props.endpointBase ?? '/api/social-content/jobs';
      const url = `${base}/${encodeURIComponent(props.jobId)}/posts/${encodeURIComponent(props.postId)}/schedule`;
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduled_at: localDate.toISOString(),
          platforms: orderedPlatforms,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setErrorMessage(payload?.error ?? 'We could not save the new schedule. Try again in a moment.');
        return;
      }
      const payload = (await response.json()) as ScheduleSavedDetail;
      setConfirmation('Saved.');
      props.onSaved?.(payload);
    } catch {
      setErrorMessage('Network error while saving the new schedule.');
    } finally {
      setSubmitting(false);
    }
  }

  const tzLabel = props.timezoneLabel ?? DEFAULT_TIMEZONE;
  const orderedPlatformChips: PlatformId[] = PLATFORM_OPTIONS
    .map((option) => option.id)
    .filter((id) => platforms.has(id));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reschedule-drawer-title"
      data-testid="reschedule-drawer"
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 px-4 pb-6 pt-20 backdrop-blur-sm sm:items-center sm:pb-12"
    >
      <button
        type="button"
        aria-label="Close reschedule drawer"
        onClick={props.onClose}
        className="absolute inset-0 cursor-default"
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#101418]/95 shadow-[0_32px_120px_rgba(0,0,0,0.5)] backdrop-blur-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/8 px-6 py-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/80">
              <CalendarClock className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/40">Reschedule post</p>
              <h2 id="reschedule-drawer-title" className="mt-1 text-base font-semibold text-white">
                When and where should this go live?
              </h2>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={props.onClose}
            disabled={submitting}
            className="rounded-full border border-white/10 p-2 text-white/65 transition hover:border-white/20 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          <label className="block space-y-2 text-sm" htmlFor="reschedule-datetime">
            <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">Publish date & time</span>
            <input
              id="reschedule-datetime"
              data-testid="reschedule-datetime-input"
              type="datetime-local"
              value={scheduledAtLocal}
              onChange={(event) => {
                setErrorMessage(null);
                setScheduledAtLocal(event.target.value);
              }}
              required
              className="w-full rounded-[1rem] border border-white/12 bg-black/30 px-4 py-3 font-mono text-sm text-white placeholder:text-white/30 focus:border-white/35 focus:outline-none"
            />
            <span className="text-xs text-white/45">Times use the {tzLabel} business profile timezone.</span>
          </label>

          <fieldset className="space-y-3">
            <legend className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">Publish to</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {PLATFORM_OPTIONS.map((option) => {
                const checked = platforms.has(option.id);
                const Icon = option.Icon;
                return (
                  <label
                    key={option.id}
                    htmlFor={`reschedule-platform-${option.id}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-[1rem] border px-4 py-3 text-sm transition ${
                      checked
                        ? 'border-white/35 bg-white/[0.08] text-white'
                        : 'border-white/10 bg-black/20 text-white/65 hover:border-white/20 hover:text-white'
                    }`}
                  >
                    <input
                      id={`reschedule-platform-${option.id}`}
                      data-testid={`reschedule-platform-${option.id}`}
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePlatform(option.id)}
                      className="sr-only"
                    />
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                        checked ? 'border-white bg-white text-[#11161c]' : 'border-white/25 bg-transparent text-transparent'
                      }`}
                      aria-hidden="true"
                    >
                      <Check className="h-3 w-3" />
                    </span>
                    <Icon className="h-4 w-4 opacity-80" aria-hidden="true" />
                    <span className="font-medium">{option.label}</span>
                  </label>
                );
              })}
            </div>
            {orderedPlatformChips.length === 0 ? (
              <p className="text-xs text-amber-300/80" data-testid="reschedule-platforms-empty">
                Pick at least one platform.
              </p>
            ) : (
              <p className="text-xs text-white/40" data-testid="reschedule-platforms-summary">
                {orderedPlatformChips.length === 1 ? 'Posting to' : 'Cross-posting to'}{' '}
                <span className="font-medium text-white/70">{orderedPlatformChips.join(' + ')}</span>
              </p>
            )}
          </fieldset>

          {errorMessage ? (
            <p
              role="alert"
              data-testid="reschedule-error"
              className="rounded-[0.85rem] border border-rose-300/25 bg-rose-300/10 px-3 py-2 text-sm text-rose-100"
            >
              {errorMessage}
            </p>
          ) : null}
          {confirmation ? (
            <p
              role="status"
              data-testid="reschedule-confirmation"
              className="rounded-[0.85rem] border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100"
            >
              {confirmation}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-white/8 bg-black/15 px-6 py-4">
          <button
            type="button"
            onClick={props.onClose}
            disabled={submitting}
            className="rounded-full border border-white/12 px-4 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/20 hover:text-white disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="reschedule-submit"
            disabled={submitting || orderedPlatformChips.length === 0}
            style={{ color: '#11161c' }}
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold disabled:opacity-60"
          >
            {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
            {submitting ? 'Saving' : 'Save schedule'}
          </button>
        </footer>
      </form>
    </div>
  );
}
