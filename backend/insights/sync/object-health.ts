/**
 * backend/insights/sync/object-health.ts
 *
 * Pure decision logic for quarantining a dead platform object.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `insights_posts.last_metrics_fetched_at` was stamped only on SUCCESS, and the
 * comments leg had no watermark at all. A post deleted on-platform (or scoped
 * away by a permission change) therefore answered Graph `(#100)` forever, was
 * re-selected by EVERY 30-minute tick, pushed a fresh legError each time, and
 * pinned its account's sync run at `partial` indefinitely — the "same object
 * ids failing for 72 h+ with no alert" signature (audit F8, tenant 15).
 *
 * The fix is a per-object strike counter with a quarantine watermark. Once an
 * object converges to "known dead", it stops being selected (until a re-probe
 * window) and stops contributing to `legErrors` — so the account's run status
 * returns to `ok` and `partial` means something again.
 *
 * WHY COUNT-BASED, NOT PATTERN-BASED
 * ----------------------------------
 * `isPermanentObjectError` only accelerates convergence (2 strikes instead of
 * 5). An error string nobody has seen before still quarantines, just slower.
 * A pattern list that must be exhaustive to work would rot; this one only has
 * to be *right when it matches*.
 *
 * WHY `postSpecific` GATES EVERYTHING
 * -----------------------------------
 * A platform-wide outage (or an expired page token) fails every object in the
 * loop. Striking them all would quarantine an entire account's history over one
 * bad afternoon. `postSpecific` is the caller's evidence that the failure is
 * about THIS object and not the platform: either at least one sibling object
 * succeeded in the same run, or the error string is a recognised
 * object-permanent one.
 *
 * Pure and total — no I/O, no clock, no DB. The dispatcher owns the SQL; this
 * module owns the judgement.
 */

/** Strikes before quarantine when the error is a recognised permanent one. */
export const QUARANTINE_STRIKES_PERMANENT = 2;

/**
 * Strikes before quarantine for an unrecognised error. Five consecutive
 * failing ticks ≈ 2.5 h at the 30-minute cadence, and any single success
 * resets the counter to 0 — so a flaky object never converges here.
 */
export const QUARANTINE_STRIKES_GENERIC = 5;

/**
 * A quarantined object is re-selected once this many days have passed, so a
 * post that came back (unarchived, permissions restored) heals itself without
 * an operator. One re-probe every 14 days is ~2 wasted API calls per dead
 * object per month — cheap enough to never need a manual un-quarantine.
 */
export const REPROBE_AFTER_DAYS = 14;

/**
 * Threshold meaning "do not quarantine on this failure". int4 max, so it can be
 * bound straight into the same `metrics_error_count + 1 >= $n` comparison as a
 * real threshold — the failure path stays ONE atomic statement with no branch.
 */
export const QUARANTINE_NEVER_THRESHOLD = 2147483647;

/**
 * Graph/platform errors that mean "this object will never answer again".
 * Verbatim fragments from real Meta Graph responses.
 */
const PERMANENT_MARKERS: RegExp[] = [
  /\(#100\)/,                                   // Graph: invalid parameter / unknown object
  /Object with ID/i,                            // "Object with ID '...' does not exist"
  /does not exist/i,
  /Unsupported get request/i,
  /cannot be loaded due to missing permissions/i,
];

/**
 * Markers that make an error transient REGARDLESS of any permanent marker in
 * the same string. Checked first and always wins: Graph nests explanatory text,
 * and a rate-limit body that happens to quote "does not exist" must not burn a
 * fast strike against a perfectly live object.
 */
const TRANSIENT_MARKERS: RegExp[] = [
  /rate limit/i,
  /\(#4\)/,                                     // Graph: application request limit reached
  /\(#17\)/,                                    // Graph: user request limit reached
  /\(#32\)/,                                    // Graph: page request limit reached
  /timeout/i,
  /timed out/i,
  /temporar/i,                                  // "temporarily unavailable" / "temporary"
  /ECONN/,                                      // ECONNRESET / ECONNREFUSED
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /fetch failed/i,
  /(?:HTTP|status)\s*5\d\d\b/i,
  /Internal Server Error/i,
  /Bad Gateway/i,
  /Service Unavailable/i,
  /Gateway Time-?out/i,
];

/**
 * True when `message` names an error that will not fix itself. False for the
 * empty string, for unrecognised errors, and — critically — for any message
 * carrying a transient marker even if it also carries a permanent one.
 */
export function isPermanentObjectError(message: string): boolean {
  const text = typeof message === 'string' ? message : '';
  if (!text) return false;
  if (TRANSIENT_MARKERS.some((re) => re.test(text))) return false;
  return PERMANENT_MARKERS.some((re) => re.test(text));
}

export interface QuarantineDecision {
  /** Strikes this object has already accumulated on this leg (pre-increment). */
  errorCount: number;
  /** isPermanentObjectError(message) for the failure being recorded. */
  permanent: boolean;
  /** Caller's evidence that the failure is about this object, not the platform. */
  postSpecific: boolean;
}

/** Strikes required before this failure may quarantine the object. */
export function quarantineThreshold(permanent: boolean): number {
  return permanent ? QUARANTINE_STRIKES_PERMANENT : QUARANTINE_STRIKES_GENERIC;
}

/**
 * The threshold to bind into the failure UPDATE. Returns the never-quarantine
 * sentinel when the failure is not object-specific, so the SQL needs no branch.
 */
export function quarantineThresholdFor(input: { permanent: boolean; postSpecific: boolean }): number {
  return input.postSpecific ? quarantineThreshold(input.permanent) : QUARANTINE_NEVER_THRESHOLD;
}

/**
 * Would this failure (the `errorCount + 1`-th) cross the threshold?
 * Mirrors the ENTRY arm of the CASE in the dispatcher's atomic UPDATE (the
 * NOT-yet-quarantined case). The CASE carries one further arm this function
 * has no opinion on: an object that is ALREADY quarantined re-stamps its
 * watermark on a failed re-probe, so the 14-day window restarts instead of
 * staying permanently expired. The dispatcher does not call this on the write
 * path (the database decides, atomically) — it exists so the rule is testable
 * and so callers can reason about convergence.
 */
export function shouldQuarantine(input: QuarantineDecision): boolean {
  if (!input.postSpecific) return false;
  return input.errorCount + 1 >= quarantineThreshold(input.permanent);
}
