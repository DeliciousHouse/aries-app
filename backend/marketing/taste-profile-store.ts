/**
 * Per-(tenant, user) marketing taste profile — the fast, read-time-biasing
 * store fed by the onboarding first-post variant board (pick / rate / edit).
 * Mirrors backend/marketing/operator-creative-preferences-store.ts (default
 * pool import, injectable `client: Queryable = pool`, INTEGER tenant/user ids).
 *
 * Data model (the opaque `dimensions` jsonb on marketing_taste_profile):
 *
 *   { [dimension]: { [value]: { approved_count, rejected_count, last_seen } } }
 *
 * e.g. { "visual_style": { "Bold Minimalist": { approved_count: 3,
 *        rejected_count: 0, last_seen: "2026-06-02T..." } } }
 *
 * Raw counters are the single source of truth. Confidence (Laplace) and the
 * 5%/week decay are derived at READ time (getTasteProfile), so a read never
 * mutates the row — same trick gstack's taste-profile.json uses. Writes
 * (applyTasteSignal) deep-merge a single (dimension, value) counter in SQL so
 * concurrent signals don't clobber each other (no read-modify-write race).
 */
import pool from '@/lib/db';

type Queryable = Pick<typeof pool, 'query'>;

/** Relative confidence decay applied per week of staleness, at read time. */
export const DECAY_PER_WEEK = 0.05;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Below this decayed confidence, a dimension is too weak to bias a brief. */
export const MIN_BRIEF_CONFIDENCE = 0.5;

/** Stored per-(dimension,value) counter (jsonb leaf). */
export type StoredTasteCounter = {
  approved_count: number;
  rejected_count: number;
  /** ISO timestamp of the most recent signal for this value. */
  last_seen: string;
};

/** Stored jsonb shape of marketing_taste_profile.dimensions. */
export type StoredTasteDimensions = Record<string, Record<string, StoredTasteCounter>>;

/** Read-time projection of one dimension: its top value + decayed confidence. */
export type TasteDimensionView = {
  value: string;
  /** Decayed approved/rejected counts (informational; confidence is the signal). */
  approved_count: number;
  rejected_count: number;
  /** Laplace confidence on the decayed counts: approved / (approved + rejected + 1). */
  confidence: number;
  last_seen: string;
};

export type TasteProfileView = {
  dimensions: Record<string, TasteDimensionView>;
  updated_at: string;
};

/**
 * Small brief-injection shape consumed (in a later phase) by resolveCreativeBriefs
 * and buildBrandKitPayload. Every field is string[] so the consumer can either
 * spread entries (creative_briefs) or join into a sentence (voice/style_vibe) —
 * both trivial from string[]; the reverse is lossy.
 */
export type TasteDimensions = {
  style_descriptors: string[];
  voice_descriptors: string[];
  audience_descriptors: string[];
  avoid: string[];
};

/** Canonical taste-dimension keys (the producer in a later phase and the brief
 * consumer must agree on these so signals route to the right brief field). */
export const TASTE_DIMENSION_KEYS = {
  VOICE: 'voice',
  VISUAL_STYLE: 'visual_style',
  COLOR_PALETTE: 'color_palette',
  DENSITY: 'density',
  AUDIENCE: 'audience',
  AVOID: 'avoid',
} as const;

// ---------------------------------------------------------------------------
// Pure math (no DB, no Date.now()) — unit-tested directly.
// ---------------------------------------------------------------------------

/** Coerce a stored count to a finite, non-negative number. Defensive against
 * malformed/legacy/hand-edited jsonb leaves (the write path only ever stores
 * ints): a non-numeric leaf decays to 0 instead of poisoning the math with NaN. */
export function safeCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Laplace-smoothed confidence: approved / (approved + rejected + 1). */
export function laplaceConfidence(approved: number, rejected: number): number {
  const a = Math.max(0, approved);
  const r = Math.max(0, rejected);
  return a / (a + r + 1);
}

/**
 * Multiplicative 5%/week decay factor for a value last seen at `lastSeenIso`,
 * evaluated at `nowMs`. Returns 1 (no decay) for a missing/invalid/future
 * timestamp. Pure: pass `nowMs` explicitly so callers/tests stay deterministic.
 */
export function decayFactor(
  lastSeenIso: string | null | undefined,
  nowMs: number,
  ratePerWeek: number = DECAY_PER_WEEK,
): number {
  if (!lastSeenIso) return 1;
  const lastSeenMs = Date.parse(lastSeenIso);
  if (!Number.isFinite(lastSeenMs)) return 1;
  const weeks = Math.max(0, (nowMs - lastSeenMs) / WEEK_MS);
  return Math.pow(1 - ratePerWeek, weeks);
}

/**
 * Collapse one dimension's competing values to a single view: the value with
 * the highest decayed Laplace confidence (tie-break: more approvals, then more
 * recently seen). Returns null when the dimension has no usable values.
 */
export function summarizeDimensionValues(
  values: Record<string, StoredTasteCounter> | null | undefined,
  nowMs: number,
): TasteDimensionView | null {
  let best: TasteDimensionView | null = null;
  for (const [value, counter] of Object.entries(values ?? {})) {
    if (!counter) continue;
    const factor = decayFactor(counter.last_seen, nowMs);
    const approved = safeCount(counter.approved_count) * factor;
    const rejected = safeCount(counter.rejected_count) * factor;
    const confidence = laplaceConfidence(approved, rejected);
    const view: TasteDimensionView = {
      value,
      approved_count: approved,
      rejected_count: rejected,
      confidence,
      last_seen: counter.last_seen,
    };
    if (
      best === null ||
      view.confidence > best.confidence ||
      (view.confidence === best.confidence && view.approved_count > best.approved_count) ||
      (view.confidence === best.confidence &&
        view.approved_count === best.approved_count &&
        Date.parse(view.last_seen) > Date.parse(best.last_seen))
    ) {
      best = view;
    }
  }
  return best;
}

/** Project the full stored dimensions map to per-dimension top-value views. */
export function summarizeDimensions(
  raw: StoredTasteDimensions | null | undefined,
  nowMs: number,
): Record<string, TasteDimensionView> {
  const out: Record<string, TasteDimensionView> = {};
  for (const [dimension, values] of Object.entries(raw ?? {})) {
    const view = summarizeDimensionValues(values, nowMs);
    if (view) out[dimension] = view;
  }
  return out;
}

/** Route a high-confidence dimension's value into the right brief bucket. */
export function briefBucketForDimension(dimension: string): keyof TasteDimensions {
  switch (dimension) {
    case TASTE_DIMENSION_KEYS.VOICE:
      return 'voice_descriptors';
    case TASTE_DIMENSION_KEYS.AUDIENCE:
      return 'audience_descriptors';
    case TASTE_DIMENSION_KEYS.AVOID:
      return 'avoid';
    case TASTE_DIMENSION_KEYS.VISUAL_STYLE:
    case TASTE_DIMENSION_KEYS.COLOR_PALETTE:
    case TASTE_DIMENSION_KEYS.DENSITY:
    default:
      return 'style_descriptors';
  }
}

/**
 * Reduce a read-time profile view to the small brief-injection shape, keeping
 * only dimensions whose decayed confidence clears MIN_BRIEF_CONFIDENCE. Returns
 * null when nothing clears the bar (so brief assembly can cleanly skip taste).
 */
export function projectTasteForBrief(view: TasteProfileView | null): TasteDimensions | null {
  if (!view) return null;
  const out: TasteDimensions = {
    style_descriptors: [],
    voice_descriptors: [],
    audience_descriptors: [],
    avoid: [],
  };
  let any = false;
  for (const [dimension, dim] of Object.entries(view.dimensions)) {
    if (!(Number.isFinite(dim.confidence) && dim.confidence >= MIN_BRIEF_CONFIDENCE)) continue;
    const label = dim.value.trim();
    if (!label) continue;
    out[briefBucketForDimension(dimension)].push(label);
    any = true;
  }
  return any ? out : null;
}

// ---------------------------------------------------------------------------
// Persistence (injectable client, mirroring operator-creative-preferences-store).
// ---------------------------------------------------------------------------

function parseTenantId(tenantId: string): number | null {
  const n = Number.parseInt(String(tenantId).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseUserId(userId: string): number | null {
  const n = Number.parseInt(String(userId).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Load the decayed taste profile for a (tenant, user). Decay + Laplace
 * confidence are computed here at read time (relative to now); the stored row
 * is untouched. Returns null for an unknown user or invalid ids.
 */
export async function getTasteProfile(
  tenantId: string,
  userId: string,
  client: Queryable = pool,
): Promise<TasteProfileView | null> {
  const tid = parseTenantId(tenantId);
  const uid = parseUserId(userId);
  if (tid === null || uid === null) return null;

  const r = await client.query<{
    dimensions: StoredTasteDimensions; // pg auto-parses jsonb into a JS object
    updated_at: Date;
  }>(
    `SELECT dimensions, updated_at
       FROM marketing_taste_profile
      WHERE tenant_id = $1 AND user_id = $2`,
    [tid, uid],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    dimensions: summarizeDimensions(row.dimensions ?? {}, Date.now()),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Record one taste signal: bump a single (dimension, value) counter by `weight`
 * on the approved or rejected side, stamping last_seen = now. The jsonb
 * deep-merge happens entirely in SQL (jsonb_set on the dimension path, `||`
 * concat on the value key) so it preserves sibling dimensions/values and is
 * atomic under concurrent signals. Returns the freshly decayed profile view.
 */
export async function applyTasteSignal(
  input: {
    tenantId: string;
    userId: string;
    dimension: string;
    value: string;
    outcome: 'approved' | 'rejected';
    /** Signal strength added to the counter (e.g. graded by star rating). Default 1. */
    weight?: number;
  },
  client: Queryable = pool,
): Promise<TasteProfileView> {
  const tid = parseTenantId(input.tenantId);
  const uid = parseUserId(input.userId);
  if (tid === null || uid === null) {
    throw new Error('[taste-profile] invalid tenant_id or user_id');
  }
  const dimension = input.dimension.trim();
  const value = input.value.trim();
  if (!dimension) throw new Error('[taste-profile] empty dimension');
  if (!value) throw new Error('[taste-profile] empty value');

  const weight = Math.max(1, Math.trunc(input.weight ?? 1));
  const approvedDelta = input.outcome === 'approved' ? weight : 0;
  const rejectedDelta = input.outcome === 'rejected' ? weight : 0;
  const nowIso = new Date().toISOString();

  const r = await client.query<{
    dimensions: StoredTasteDimensions;
    updated_at: Date;
  }>(
    `INSERT INTO marketing_taste_profile (tenant_id, user_id, dimensions, updated_at)
     VALUES (
       $1, $2,
       jsonb_build_object(
         $3::text,
         jsonb_build_object(
           $4::text,
           jsonb_build_object('approved_count', $5::int, 'rejected_count', $6::int, 'last_seen', $7::text)
         )
       ),
       now()
     )
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       dimensions = jsonb_set(
         COALESCE(marketing_taste_profile.dimensions, '{}'::jsonb),
         ARRAY[$3::text],
         (
           COALESCE(marketing_taste_profile.dimensions -> $3, '{}'::jsonb) || jsonb_build_object(
             $4::text,
             jsonb_build_object(
               'approved_count',
                 COALESCE((marketing_taste_profile.dimensions -> $3 -> $4 ->> 'approved_count')::int, 0) + $5::int,
               'rejected_count',
                 COALESCE((marketing_taste_profile.dimensions -> $3 -> $4 ->> 'rejected_count')::int, 0) + $6::int,
               'last_seen', $7::text
             )
           )
         ),
         true
       ),
       updated_at = now()
     RETURNING dimensions, updated_at`,
    [tid, uid, dimension, value, approvedDelta, rejectedDelta, nowIso],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error('[taste-profile] upsert returned no row');
  }
  return {
    dimensions: summarizeDimensions(row.dimensions ?? {}, Date.now()),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Read helper for brief assembly: the decayed taste profile reduced to the small
 * string[] brief-injection shape (high-confidence dimensions only). Returns null
 * when there is no profile or nothing clears MIN_BRIEF_CONFIDENCE.
 *
 * Phase 1 DEFINES this; wiring into resolveCreativeBriefs / buildBrandKitPayload
 * lands in a later phase.
 */
export async function loadTasteForBrief(
  tenantId: string,
  userId: string,
  client: Queryable = pool,
): Promise<TasteDimensions | null> {
  const view = await getTasteProfile(tenantId, userId, client);
  return projectTasteForBrief(view);
}
