'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';

import { customerSafeUiErrorMessage } from './customer-safe-copy';

const DRAWER_GENERIC_ERROR = 'That action could not complete right now.';

// Whitelist of backend `error` codes whose meaning is safe and useful to show
// the operator with curated copy. Anything not in this map and matching an
// internal-looking shape gets the fallback instead of the raw code.
const CREATIVE_ACTION_USER_ERROR_COPY: Readonly<Record<string, string>> = {
  unsupported_mime_type: 'That file type is not supported. Use PNG, JPEG, or WebP.',
  unsupported_media_type: 'That file type is not supported. Use PNG, JPEG, or WebP.',
  file_too_large: 'That file is too large. The maximum size is 8 MB.',
  missing_file: 'No file was selected. Choose an image to upload.',
  invalid_multipart: 'The upload could not be processed. Try again.',
  override_requires_tos_acknowledgement:
    'Confirm the ToS checkbox before overriding.',
  nsfw_detected: 'This image did not pass brand QA.',
  creative_not_found: 'This creative is no longer available.',
  social_content_job_not_found: 'This post is no longer available in this workspace.',
  missing_creative_id: 'This creative is missing required information.',
  missing_source_run_id: 'This creative has no prior run to regenerate from.',
};

// Patterns that strongly suggest an internal/provider/storage identifier the
// operator should never see verbatim. The list is intentionally broad — any
// match routes to the fallback. Curated codes above bypass this check.
const CREATIVE_ACTION_INTERNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /hermes/i,
  /provider/i,
  /storage/i,
  /\bdb_|database/i,
  /upstream/i,
  /timeout/i,
  /aries_run/i,
  /workflow/i,
  /gateway/i,
  /regenerate_run/i,
  /run_submission/i,
  /(_|^)(failed|failure|unavailable|unauthorized|forbidden|error)$/i,
];

export function creativeActionSafeErrorMessage(
  raw: string | null | undefined,
  fallback: string = DRAWER_GENERIC_ERROR,
): string {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim();
  if (!normalized) return fallback;

  const lower = normalized.toLowerCase();
  const curated = CREATIVE_ACTION_USER_ERROR_COPY[lower];
  if (curated) return curated;

  if (CREATIVE_ACTION_INTERNAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return fallback;
  }

  // Snake_case-only identifiers that aren't curated above are treated as
  // internal codes by default — UI never speaks `foo_bar_baz` at the user.
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(lower)) {
    return fallback;
  }

  return customerSafeUiErrorMessage(normalized, fallback);
}

// Visible drawer trigger gate. The drawer is image-only because T14/T15
// regenerate and upload-replace endpoints only accept image creatives. Video
// scripts and other review surfaces never see this control.
export type CreativeActionDrawerGate = {
  reviewType?: string | null;
  contentType?: string | null;
  assetId?: string | null;
};

export function canShowCreativeActionDrawer(
  input: CreativeActionDrawerGate | null | undefined,
): boolean {
  if (!input) return false;
  if (input.reviewType !== 'creative') return false;
  const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
  if (!assetId) return false;
  const contentType =
    typeof input.contentType === 'string' ? input.contentType.trim().toLowerCase() : '';
  if (!contentType.startsWith('image/')) return false;
  return true;
}

// Pure request builders so tests can pin URL + method + body shape without
// rendering React or hitting a real server. Component code below uses these
// builders directly so the drawer and the test suite agree on contract.

export function regenerateCreativeUrl(jobId: string, creativeId: string): string {
  return `/api/social-content/jobs/${encodeURIComponent(jobId)}/creatives/${encodeURIComponent(creativeId)}/regenerate`;
}

export function uploadReplaceCreativeUrl(jobId: string, creativeId: string): string {
  return `/api/social-content/jobs/${encodeURIComponent(jobId)}/creatives/${encodeURIComponent(creativeId)}/upload-replace`;
}

export function creativeVoicePreferenceUrl(jobId: string): string {
  return `/api/social-content/jobs/${encodeURIComponent(jobId)}/creative-voice-preference`;
}

export type UploadReplaceOverrideInput = {
  operatorOverride: true;
  tosAcknowledged: true;
};

export function buildUploadReplaceFormData(
  file: File,
  override?: UploadReplaceOverrideInput,
): FormData {
  const formData = new FormData();
  formData.set('image', file);
  if (override) {
    formData.set('operator_override', 'true');
    formData.set('tos_acknowledged', 'true');
  }
  return formData;
}

export type QaScores = {
  brand_color_match: number;
  text_legibility: number;
  brand_violation: number;
  forbidden_pattern_hits: number;
};

export type QaPayload = {
  verdict: string;
  scores: QaScores;
  reasons: string[];
  attempt_number: number;
};

export function readQaPayload(body: unknown): QaPayload | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>)['qa'];
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const scoresRaw = candidate.scores;
  if (!scoresRaw || typeof scoresRaw !== 'object') return null;
  const scoresCandidate = scoresRaw as Record<string, unknown>;
  const reasonsRaw = candidate.reasons;
  return {
    verdict: typeof candidate.verdict === 'string' ? candidate.verdict : 'unknown',
    scores: {
      brand_color_match: numberOrZero(scoresCandidate.brand_color_match),
      text_legibility: numberOrZero(scoresCandidate.text_legibility),
      brand_violation: numberOrZero(scoresCandidate.brand_violation),
      forbidden_pattern_hits: numberOrZero(scoresCandidate.forbidden_pattern_hits),
    },
    reasons: Array.isArray(reasonsRaw) ? reasonsRaw.map((entry) => String(entry)) : [],
    attempt_number: Math.max(1, Math.floor(numberOrZero(candidate.attempt_number)) || 1),
  };
}

function numberOrZero(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

type ScoreKind = 'higher_is_better' | 'lower_is_better' | 'count';

const SCORE_DEFS: ReadonlyArray<{ key: keyof QaScores; label: string; kind: ScoreKind }> = [
  { key: 'brand_color_match', label: 'Brand color match', kind: 'higher_is_better' },
  { key: 'text_legibility', label: 'Text legibility', kind: 'higher_is_better' },
  { key: 'brand_violation', label: 'Brand violation', kind: 'lower_is_better' },
  { key: 'forbidden_pattern_hits', label: 'Forbidden patterns', kind: 'count' },
];

function ScoreBar(props: { label: string; score: number; kind: ScoreKind; testId: string }) {
  if (props.kind === 'count') {
    const isBad = props.score > 0;
    return (
      <div className="space-y-1.5" data-testid={props.testId}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-white/70">{props.label}</span>
          <span
            className={`text-xs tabular-nums ${isBad ? 'text-rose-200/95' : 'text-emerald-200/90'}`}
            data-testid={`${props.testId}-value`}
          >
            {Math.round(props.score)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
          <div
            className={`h-1.5 rounded-full transition-[width] duration-500 ${isBad ? 'bg-rose-300/80' : 'bg-emerald-300/60'}`}
            style={{ width: isBad ? '100%' : '8%' }}
          />
        </div>
      </div>
    );
  }
  const ratio = clampUnit(props.score);
  const goodScore = props.kind === 'higher_is_better' ? ratio : 1 - ratio;
  const tone =
    goodScore >= 0.75
      ? { fg: 'text-emerald-200/95', bar: 'bg-emerald-300/70' }
      : goodScore >= 0.5
        ? { fg: 'text-amber-200/95', bar: 'bg-amber-300/70' }
        : { fg: 'text-rose-200/95', bar: 'bg-rose-300/80' };
  return (
    <div className="space-y-1.5" data-testid={props.testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-white/70">{props.label}</span>
        <span
          className={`text-xs tabular-nums ${tone.fg}`}
          data-testid={`${props.testId}-value`}
        >
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
        <div
          className={`h-1.5 rounded-full transition-[width] duration-500 ${tone.bar}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

type RegenerateState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; runId: string | null }
  | { kind: 'error'; message: string };

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'accepted'; verdict: string; qa: QaPayload | null; operatorOverride: boolean }
  | { kind: 'qa_failed'; qa: QaPayload | null; message: string }
  | { kind: 'error'; message: string };

export type CreativeActionDrawerProps = {
  jobId: string;
  creativeId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void | Promise<void>;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
};

export default function CreativeActionDrawer(props: CreativeActionDrawerProps) {
  const fetcher = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  const [regen, setRegen] = useState<RegenerateState>({ kind: 'idle' });
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' });
  const [tosChecked, setTosChecked] = useState(false);
  const [voicePref, setVoicePref] = useState<{
    always: boolean;
    label: string;
    loaded: boolean;
  }>({ always: false, label: '', loaded: false });
  const [voicePrefSaving, setVoicePrefSaving] = useState(false);
  const [voicePrefMessage, setVoicePrefMessage] = useState<string | null>(null);
  const [voicePrefError, setVoicePrefError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastFileRef = useRef<File | null>(null);

  // Reset on open/close so a stale failure UI never bleeds across opens.
  useEffect(() => {
    if (!props.isOpen) {
      setRegen({ kind: 'idle' });
      setUpload({ kind: 'idle' });
      setTosChecked(false);
      setVoicePref({ always: false, label: '', loaded: false });
      setVoicePrefSaving(false);
      setVoicePrefMessage(null);
      setVoicePrefError(null);
      lastFileRef.current = null;
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [props.isOpen]);

  useEffect(() => {
    if (!props.isOpen || !fetcher) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetcher(creativeVoicePreferenceUrl(props.jobId));
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled) return;
        if (res.ok && body.status === 'ok') {
          setVoicePref({
            always: Boolean(body.always_match_creative_voice),
            label: typeof body.voice_style_label === 'string' ? body.voice_style_label : '',
            loaded: true,
          });
        } else {
          setVoicePref((prev) => ({ ...prev, loaded: true }));
        }
      } catch {
        if (!cancelled) {
          setVoicePref((prev) => ({ ...prev, loaded: true }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.isOpen, props.jobId, fetcher]);

  const triggerSuccessRefresh = useCallback(async () => {
    if (props.onSuccess) {
      try {
        await props.onSuccess();
      } catch {
        // Refresh failure is non-fatal for the drawer; the action already
        // succeeded server-side. Avoid noisy UI here.
      }
    }
  }, [props]);

  const handleRegenerate = useCallback(async () => {
    if (!fetcher) {
      setRegen({ kind: 'error', message: DRAWER_GENERIC_ERROR });
      return;
    }
    setRegen({ kind: 'submitting' });
    try {
      const response = await fetcher(regenerateCreativeUrl(props.jobId, props.creativeId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status !== 202 || body.status !== 'submitted') {
        const message = creativeActionSafeErrorMessage(
          typeof body.error === 'string' ? body.error : null,
          DRAWER_GENERIC_ERROR,
        );
        setRegen({ kind: 'error', message });
        return;
      }
      const runId = typeof body.new_run_id === 'string' ? body.new_run_id : null;
      setRegen({ kind: 'submitted', runId });
      await triggerSuccessRefresh();
    } catch (error) {
      const message = creativeActionSafeErrorMessage(
        error instanceof Error ? error.message : null,
        DRAWER_GENERIC_ERROR,
      );
      setRegen({ kind: 'error', message });
    }
  }, [fetcher, props.creativeId, props.jobId, triggerSuccessRefresh]);

  const submitUpload = useCallback(
    async (file: File, override?: UploadReplaceOverrideInput) => {
      if (!fetcher) {
        setUpload({ kind: 'error', message: DRAWER_GENERIC_ERROR });
        return;
      }
      setUpload({ kind: 'uploading' });
      try {
        const response = await fetcher(
          uploadReplaceCreativeUrl(props.jobId, props.creativeId),
          {
            method: 'POST',
            body: buildUploadReplaceFormData(file, override),
          },
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const qa = readQaPayload(body);
        if (response.status === 202 && body.status === 'accepted') {
          setUpload({
            kind: 'accepted',
            verdict: typeof body.verdict === 'string' ? body.verdict : 'pass',
            qa,
            operatorOverride: Boolean(body.operator_override),
          });
          setTosChecked(false);
          await triggerSuccessRefresh();
          return;
        }
        if (response.status === 422 && qa && qa.verdict === 'fail') {
          setUpload({
            kind: 'qa_failed',
            qa,
            message: 'This image did not pass brand QA.',
          });
          return;
        }
        const message = creativeActionSafeErrorMessage(
          typeof body.error === 'string' ? body.error : null,
          DRAWER_GENERIC_ERROR,
        );
        setUpload({ kind: 'error', message });
      } catch (error) {
        const message = creativeActionSafeErrorMessage(
          error instanceof Error ? error.message : null,
          DRAWER_GENERIC_ERROR,
        );
        setUpload({ kind: 'error', message });
      }
    },
    [fetcher, props.creativeId, props.jobId, triggerSuccessRefresh],
  );

  const handleFileChosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (!file) return;
      lastFileRef.current = file;
      await submitUpload(file);
    },
    [submitUpload],
  );

  const handleOverrideSubmit = useCallback(async () => {
    const file = lastFileRef.current;
    if (!file) return;
    if (!tosChecked) return;
    await submitUpload(file, { operatorOverride: true, tosAcknowledged: true });
  }, [submitUpload, tosChecked]);

  const handleSaveVoicePreference = useCallback(async () => {
    if (!fetcher) {
      setVoicePrefError(DRAWER_GENERIC_ERROR);
      return;
    }
    setVoicePrefSaving(true);
    setVoicePrefError(null);
    setVoicePrefMessage(null);
    try {
      const response = await fetcher(creativeVoicePreferenceUrl(props.jobId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          always_match_creative_voice: voicePref.always,
          voice_style_label: voicePref.label.trim() ? voicePref.label.trim() : null,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || body.status !== 'ok') {
        const message = creativeActionSafeErrorMessage(
          typeof body.error === 'string' ? body.error : null,
          DRAWER_GENERIC_ERROR,
        );
        setVoicePrefError(message);
        return;
      }
      setVoicePref({
        always: Boolean(body.always_match_creative_voice),
        label: typeof body.voice_style_label === 'string' ? body.voice_style_label : '',
        loaded: true,
      });
      setVoicePrefMessage('Preference saved for this workspace.');
    } catch (error) {
      setVoicePrefError(
        creativeActionSafeErrorMessage(error instanceof Error ? error.message : null, DRAWER_GENERIC_ERROR),
      );
    } finally {
      setVoicePrefSaving(false);
    }
  }, [fetcher, props.jobId, voicePref.always, voicePref.label]);

  if (!props.isOpen) {
    return null;
  }

  const uploading = upload.kind === 'uploading';
  const regenerating = regen.kind === 'submitting';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="creative-action-drawer-title"
      data-testid="creative-action-drawer"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={props.onClose}
        className="absolute inset-0 h-full w-full bg-black/55 backdrop-blur-sm"
        data-testid="creative-action-drawer-backdrop"
      />
      <aside className="relative ml-auto flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-white/10 bg-[#11161c] shadow-[0_-24px_120px_rgba(0,0,0,0.55)]">
        <header className="flex items-start justify-between gap-4 border-b border-white/8 px-6 py-5">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/40">
              Image actions
            </p>
            <h2
              id="creative-action-drawer-title"
              className="text-lg font-semibold text-white"
            >
              Replace this creative
            </h2>
            <p className="text-xs text-white/55">
              Regenerate a fresh draft or upload your own image. Uploads still go through brand QA.
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="-mr-2 -mt-1 rounded-full border border-white/10 bg-white/5 p-2 text-white/65 transition hover:border-white/20 hover:text-white"
            aria-label="Close"
            data-testid="creative-action-drawer-close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-6 px-6 py-5">
          <section className="space-y-3 rounded-[1.25rem] border border-white/10 bg-black/20 px-5 py-5">
            <div className="flex items-start gap-3">
              <RefreshCw className="mt-0.5 h-4 w-4 text-white/70" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">Regenerate this image</p>
                <p className="text-xs text-white/60">
                  Submits a new generation run. The current image stays in history until you approve a replacement.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={regenerating}
              data-testid="creative-action-regenerate"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-[#11161c] transition disabled:opacity-60"
            >
              {regenerating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {regenerating ? 'Submitting…' : 'Regenerate this image'}
            </button>
            {regen.kind === 'submitted' ? (
              <p
                className="flex items-center gap-2 text-xs text-emerald-200/90"
                data-testid="creative-action-regenerate-success"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Regenerate submitted{regen.runId ? ` (run ${regen.runId.slice(0, 12)}…)` : ''}.
              </p>
            ) : null}
            {regen.kind === 'error' ? (
              <p
                className="flex items-center gap-2 text-xs text-rose-200/90"
                data-testid="creative-action-regenerate-error"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {regen.message}
              </p>
            ) : null}
          </section>

          <section className="space-y-3 rounded-[1.25rem] border border-white/10 bg-black/20 px-5 py-5">
            <div className="flex items-start gap-3">
              <Upload className="mt-0.5 h-4 w-4 text-white/70" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">Upload your own</p>
                <p className="text-xs text-white/60">
                  PNG, JPEG, or WebP, up to 8 MB. The upload runs through brand QA before it replaces the live creative.
                </p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileChosen}
              disabled={uploading}
              data-testid="creative-action-upload-input"
              className="block w-full text-xs text-white/70 file:mr-3 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-xs file:font-semibold file:text-[#11161c] disabled:opacity-60"
            />
            {uploading ? (
              <p
                className="flex items-center gap-2 text-xs text-white/65"
                data-testid="creative-action-upload-progress"
              >
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Uploading and running brand QA…
              </p>
            ) : null}

            {upload.kind === 'accepted' ? (
              <div className="space-y-3" data-testid="creative-action-upload-success">
                <p className="flex items-center gap-2 text-xs text-emerald-200/90">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {upload.operatorOverride
                    ? 'Operator override accepted. Replacement saved.'
                    : 'Upload passed brand QA and replaced the live creative.'}
                </p>
                {upload.qa ? (
                  <QaScoreGrid qa={upload.qa} />
                ) : null}
              </div>
            ) : null}

            {upload.kind === 'qa_failed' ? (
              <div className="space-y-4" data-testid="creative-action-upload-qa-failed">
                <p className="flex items-center gap-2 text-xs text-rose-200/95">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {upload.message}
                </p>
                {upload.qa ? <QaScoreGrid qa={upload.qa} /> : null}

                <div
                  className="space-y-3 rounded-[1rem] border border-amber-300/25 bg-amber-300/8 px-4 py-4"
                  data-testid="creative-action-upload-override"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200/90">
                    Operator override
                  </p>
                  <p className="text-xs text-white/70">
                    Override only when you have explicit client sign-off. The override is logged with your account against this asset.
                  </p>
                  <label className="flex items-start gap-2 text-xs text-white/80">
                    <input
                      type="checkbox"
                      checked={tosChecked}
                      onChange={(event) => setTosChecked(event.target.checked)}
                      data-testid="creative-action-upload-override-checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40"
                    />
                    <span>
                      I confirm the client approves this image and accept responsibility for ToS compliance.
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={handleOverrideSubmit}
                    disabled={!tosChecked || uploading}
                    data-testid="creative-action-upload-override-submit"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-amber-300/40 bg-amber-300/15 px-4 py-2.5 text-sm font-semibold text-amber-100 transition disabled:opacity-50"
                  >
                    {uploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                    Override and replace anyway
                  </button>
                </div>
              </div>
            ) : null}

            {upload.kind === 'error' ? (
              <p
                className="flex items-center gap-2 text-xs text-rose-200/90"
                data-testid="creative-action-upload-error"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {upload.message}
              </p>
            ) : null}
          </section>

          <section
            className="space-y-3 rounded-[1.25rem] border border-white/10 bg-black/20 px-5 py-5"
            data-testid="creative-action-voice-preference"
          >
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-4 w-4 text-white/70" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">Creative voice preference</p>
                <p className="text-xs text-white/60">
                  When enabled, Aries remembers you want future creative work to match this job&apos;s voice and style.
                  Only saved preferences are sent to memory — not individual clicks elsewhere.
                </p>
              </div>
            </div>
            <label className="flex items-start gap-2 text-xs text-white/85">
              <input
                type="checkbox"
                checked={voicePref.always}
                disabled={!voicePref.loaded || voicePrefSaving}
                onChange={(event) => setVoicePref((prev) => ({ ...prev, always: event.target.checked }))}
                data-testid="creative-action-voice-pref-toggle"
                className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40"
              />
              <span>Always match this job&apos;s creative voice and style</span>
            </label>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/45" htmlFor="voice-pref-label">
                Optional label
              </label>
              <input
                id="voice-pref-label"
                type="text"
                value={voicePref.label}
                disabled={!voicePref.loaded || voicePrefSaving}
                maxLength={200}
                onChange={(event) => setVoicePref((prev) => ({ ...prev, label: event.target.value.slice(0, 200) }))}
                placeholder="e.g. bold minimal captions"
                data-testid="creative-action-voice-pref-label"
                className="w-full rounded-xl border border-white/12 bg-black/35 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/25 focus:outline-none disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => void handleSaveVoicePreference()}
              disabled={!voicePref.loaded || voicePrefSaving}
              data-testid="creative-action-voice-pref-save"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-white/25 disabled:opacity-50"
            >
              {voicePrefSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {voicePrefSaving ? 'Saving…' : 'Save preference'}
            </button>
            {voicePrefMessage ? (
              <p className="flex items-center gap-2 text-xs text-emerald-200/90" data-testid="creative-action-voice-pref-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {voicePrefMessage}
              </p>
            ) : null}
            {voicePrefError ? (
              <p className="flex items-center gap-2 text-xs text-rose-200/90" data-testid="creative-action-voice-pref-error">
                <AlertTriangle className="h-3.5 w-3.5" />
                {voicePrefError}
              </p>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

function QaScoreGrid({ qa }: { qa: QaPayload }) {
  return (
    <div className="space-y-3 rounded-[1rem] border border-white/8 bg-white/3 px-4 py-4" data-testid="creative-action-qa-scores">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">
          Brand QA scores
        </p>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${
            qa.verdict === 'pass'
              ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200/95'
              : qa.verdict === 'operator_override'
                ? 'border-amber-300/40 bg-amber-300/10 text-amber-200/95'
                : 'border-rose-300/40 bg-rose-300/10 text-rose-200/95'
          }`}
          data-testid="creative-action-qa-verdict"
        >
          {qa.verdict.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="grid gap-3">
        {SCORE_DEFS.map((def) => (
          <ScoreBar
            key={def.key}
            label={def.label}
            score={qa.scores[def.key]}
            kind={def.kind}
            testId={`qa-score-${def.key}`}
          />
        ))}
      </div>
    </div>
  );
}
