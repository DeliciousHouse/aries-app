'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, RefreshCw, Sparkles, Star } from 'lucide-react';

/**
 * First-post onboarding variant board: renders the 3 generated first-post
 * variants, lets the user rate (1-5 stars), regenerate / "more like this", and
 * pick one. Picking finalizes that post and lands the user on the dashboard;
 * the chosen variant's ratings + edits ride the pick request for the taste
 * write. Polls the batch status until all variants land (the "generating your
 * first posts" state), and auto-resolves to the dashboard if the board was
 * already picked or timed-out (abandoned with an auto-pick).
 *
 * Reached from /onboarding/resume when ARIES_ONBOARDING_VARIANT_BOARD_ENABLED is
 * on (the page route renders this with the batchId). Flag OFF → this never loads.
 */

export type VariantBoardCard = {
  variant_index: number;
  creative_id: string;
  served_asset_ref: string | null;
  job_id: string | null;
};

export type VariantBoardData = {
  batch_id: string;
  slot_index: number;
  board_ready: boolean;
  picked_variant_index: number | null;
  picked_creative_id: string | null;
  abandoned: boolean;
  cards: VariantBoardCard[];
};

type EditOp = { variantIndex: number; op: 'regenerate' | 'more_like_this' | 'freeform'; instruction?: string };

const VARIANT_LABELS = ['Bold & minimal', 'Warm & editorial', 'Playful & vibrant'];
const POLL_MS = 4000;

function variantLabel(index: number): string {
  return VARIANT_LABELS[index] ?? `Variant ${index + 1}`;
}

function dashboardHref(jobId: string): string {
  return `/dashboard/social-content/${encodeURIComponent(jobId)}?welcome=1`;
}

// A group of labeled toggle buttons (role=group + aria-pressed) — matches the
// click-to-set behavior actually implemented and is fully keyboard-operable
// (Tab + Enter/Space), rather than claiming radiogroup semantics without the
// arrow-key roving-focus model.
function StarRating({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value >= n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onClick={() => onChange(n)}
          className="rounded p-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a96cff]"
        >
          <Star className={`h-5 w-5 ${n <= value ? 'fill-[#a96cff] text-[#a96cff]' : 'text-white/30'}`} />
        </button>
      ))}
    </div>
  );
}

export function VariantBoard({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [board, setBoard] = useState<VariantBoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [edits, setEdits] = useState<EditOp[]>([]);
  const [freeformFor, setFreeformFor] = useState<number | null>(null);
  const [freeformText, setFreeformText] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [slow, setSlow] = useState(false);
  const resolvedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch(`/api/onboarding/variants/${encodeURIComponent(batchId)}`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) setError('We could not find your first-post board. It may have expired.');
        return;
      }
      const json = (await res.json()) as { board?: VariantBoardData };
      const view = json.board;
      if (!view) return;
      setBoard(view);
      // Already resolved (explicit pick or timeout auto-pick) → land on the dashboard.
      if (view.picked_variant_index !== null && !resolvedRef.current) {
        const chosen = view.cards.find((c) => c.variant_index === view.picked_variant_index);
        if (chosen?.job_id) {
          resolvedRef.current = true;
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          router.push(dashboardHref(chosen.job_id));
        }
      }
    } catch {
      /* transient — keep polling */
    }
  }, [batchId, router]);

  useEffect(() => {
    void fetchBoard();
    const id = setInterval(() => void fetchBoard(), POLL_MS);
    pollRef.current = id;
    // Soft timeout: after ~90s of waiting, reassure the user it's still working
    // (a single failed variant can otherwise leave the skeleton up to the 15-min
    // server-side abandon).
    const slowTimer = setTimeout(() => setSlow(true), 90_000);
    return () => {
      clearInterval(id);
      clearTimeout(slowTimer);
    };
  }, [fetchBoard]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const regenerate = useCallback(
    async (card: VariantBoardCard, op: EditOp['op'], instruction?: string) => {
      if (!card.job_id) return;
      setEditingIndex(card.variant_index);
      setEdits((prev) => [...prev, { variantIndex: card.variant_index, op, ...(instruction ? { instruction } : {}) }]);
      try {
        await fetch(
          `/api/social-content/jobs/${encodeURIComponent(card.job_id)}/creatives/${encodeURIComponent(card.creative_id)}/regenerate`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(instruction ? { instruction } : {}),
          },
        );
      } catch {
        /* the next poll reflects the new creative; nothing to surface here */
      } finally {
        setEditingIndex(null);
        setFreeformFor(null);
        setFreeformText('');
        void fetchBoard();
      }
    },
    [fetchBoard],
  );

  const pick = useCallback(
    async (card: VariantBoardCard) => {
      setPicking(true);
      setError(null);
      try {
        const ratingEntries = Object.entries(ratings).map(([variantIndex, score]) => ({
          variantIndex: Number(variantIndex),
          score,
        }));
        const res = await fetch(`/api/onboarding/variants/${encodeURIComponent(batchId)}/pick`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            selectedVariantIndex: card.variant_index,
            selectedVariantId: card.creative_id,
            ratings: ratingEntries,
            edits,
          }),
        });
        if (!res.ok) {
          // 404 (unknown/expired board or tenant mismatch), 400, 409, 5xx — the
          // pick was NOT finalized, so do not navigate as if it succeeded.
          setError('We could not finalize your pick. Please try again.');
          setPicking(false);
          return;
        }
        const json = (await res.json()) as { finalizedJobId?: string; alreadyResolved?: boolean };
        const jobId = json.finalizedJobId ?? card.job_id;
        if (jobId) {
          resolvedRef.current = true;
          stopPolling();
          router.push(dashboardHref(jobId));
          return;
        }
        setError('Your pick was saved but we could not open the dashboard. Refresh to continue.');
        setPicking(false);
      } catch {
        setError('We could not finalize your pick. Please try again.');
        setPicking(false);
      }
    },
    [batchId, ratings, edits, router],
  );

  const ready = board?.board_ready === true;
  const cards = board?.cards ?? [];

  if (!ready) {
    const landedByIndex = new Map(cards.map((c) => [c.variant_index, c]));
    return (
      <section className="space-y-5" aria-busy="true">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold text-white">Generating your first posts…</h1>
          <p className="text-sm text-white/60">
            Aries is creating three directions for your first post ({cards.length} of 3 ready). The board opens
            automatically when they’re all in.
          </p>
        </header>
        <div className="grid gap-6 md:grid-cols-3">
          {[0, 1, 2].map((i) => {
            const card = landedByIndex.get(i);
            return (
              <div
                key={i}
                className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03]"
              >
                {card?.served_asset_ref ? (
                  <img
                    src={card.served_asset_ref}
                    alt={`First-post variant: ${variantLabel(i)}`}
                    className="h-full w-full object-cover opacity-80"
                  />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-white/40" />
                )}
              </div>
            );
          })}
        </div>
        {slow ? (
          <p className="text-sm text-white/50">
            Still working — high-quality images can take a couple of minutes. You can keep this open or refresh.
          </p>
        ) : null}
        {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-white">Pick your first post</h1>
        <p className="text-sm text-white/60">
          Three directions for your first post. Rate them, regenerate any you want to push further, then pick the one to
          publish — the rest of your week is built around your choice.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-3">
        {cards.map((card) => {
          const isEditing = editingIndex === card.variant_index;
          return (
            <article
              key={card.variant_index}
              className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4"
            >
              <div className="relative aspect-[4/5] overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                {card.served_asset_ref ? (
                  <img
                    src={card.served_asset_ref}
                    alt={`First-post variant: ${variantLabel(card.variant_index)}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-white/40">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                )}
                {isEditing ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white">{variantLabel(card.variant_index)}</span>
                <StarRating
                  value={ratings[card.variant_index] ?? 0}
                  onChange={(v) => setRatings((prev) => ({ ...prev, [card.variant_index]: v }))}
                  label={`Rate the ${variantLabel(card.variant_index)} variant`}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void regenerate(card, 'regenerate')}
                  disabled={isEditing || picking || !card.job_id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white transition hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                </button>
                <button
                  type="button"
                  onClick={() => void regenerate(card, 'more_like_this')}
                  disabled={isEditing || picking || !card.job_id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white transition hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Sparkles className="h-3.5 w-3.5" /> More like this
                </button>
                <button
                  type="button"
                  onClick={() => setFreeformFor(freeformFor === card.variant_index ? null : card.variant_index)}
                  disabled={isEditing || picking || !card.job_id}
                  className="inline-flex items-center rounded-full border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white transition hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Edit…
                </button>
              </div>

              {freeformFor === card.variant_index ? (
                <div className="space-y-2">
                  <label className="text-xs text-white/60" htmlFor={`freeform-${card.variant_index}`}>
                    What would you change about the {variantLabel(card.variant_index)} variant?
                  </label>
                  <textarea
                    id={`freeform-${card.variant_index}`}
                    value={freeformText}
                    onChange={(e) => setFreeformText(e.target.value)}
                    rows={2}
                    placeholder="e.g. warmer lighting, less text — we’ll use this to tune your posts"
                    className="w-full rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[#a96cff] focus:outline-none"
                  />
                  <p className="text-[11px] text-white/40">
                    Your note tunes your upcoming posts; “Regenerate” gives this variant a fresh take.
                  </p>
                  <button
                    type="button"
                    onClick={() => void regenerate(card, 'freeform', freeformText.trim() || undefined)}
                    disabled={isEditing || picking || freeformText.trim().length === 0}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#a96cff]/40 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-white transition hover:border-[#a96cff] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Save note &amp; regenerate
                  </button>
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => void pick(card)}
                disabled={picking || isEditing || !card.served_asset_ref}
                className="mt-auto inline-flex items-center justify-center gap-2 rounded-full border border-[#a96cff]/40 bg-[linear-gradient(90deg,#5c2e96,#7a41c2,#a96cff)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_24px_rgba(169,108,255,0.2)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {picking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Pick this post
              </button>
            </article>
          );
        })}
      </div>

      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </section>
  );
}

export default VariantBoard;
