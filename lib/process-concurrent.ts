/**
 * Bounded-concurrency map. Processes `items` with `fn` running up to
 * `concurrency` calls in flight at any time. Returns results in the same
 * order as `items` (so callers can replace `for…of` serial loops without
 * having to add an explicit sort).
 *
 * Why this exists: dashboard endpoints (`/api/marketing/reviews`,
 * `/api/marketing/campaigns`) iterated the per-tenant job list serially,
 * doing `await loadSocialContentJobRuntime` + `await getMarketingJobStatus` +
 * `await buildSocialContentWorkspaceView` + `await buildReviewItemsForJob` for
 * EACH job. Tenants with 30+ jobs (active + history) saw 24-36s response
 * times, hanging the dashboard on "Loading…". Bounded parallelism cuts
 * wall-clock time by a factor of `concurrency` without exhausting the DB
 * pool — see operational guardrail #1 in CLAUDE.md.
 *
 * Concurrency picking guide:
 *   - 4 is safe for DB_POOL_MAX=20 (uses ≤20% of pool per request).
 *   - Match `ARIES_WEB_CONCURRENCY` if you can — that's the per-container
 *     worker count, and total peak DB pressure is roughly
 *     `ARIES_WEB_CONCURRENCY * concurrency`.
 *   - Higher than 8 risks pool contention with no payoff for these
 *     filesystem-heavy + per-job-DB workloads.
 *
 * Error semantics: once any worker's `fn(item)` rejects, the FIRST error is
 * captured. Remaining workers stop claiming new items, but any items already
 * in-flight when the error landed are allowed to settle (so the function does
 * not return until every started call has resolved or rejected). After every
 * in-flight call settles, the first error is re-thrown. Items that hadn't
 * started yet when the error landed will have `undefined` in their result
 * slot — but the function throws before the caller ever sees the array, so
 * this is invisible to callers using the happy path. Callers that need
 * partial results on error should catch in `fn` instead.
 */
export async function processConcurrent<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<U>,
  concurrency: number,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }
  // Floor + clamp against items.length and against the lower bound 1, so
  // non-finite (NaN, Infinity, -Infinity) and out-of-range values (0, negative,
  // huge) all degrade to serial-or-bounded behavior instead of producing a
  // never-starting worker pool (Math.max(1, NaN) is NaN, which silently broke
  // the loop). Number.isFinite is the explicit NaN/Infinity guard.
  const floored = Math.floor(concurrency);
  const safeConcurrency = Number.isFinite(floored)
    ? Math.max(1, Math.min(floored, items.length))
    : 1;
  if (safeConcurrency === 1) {
    const results: U[] = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await fn(items[i], i));
    }
    return results;
  }

  const results: U[] = new Array(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (true) {
      // Stop claiming new work once any sibling has errored — already-in-flight
      // calls will still settle (the in-flight `await fn(...)` below isn't
      // cancelable from here, by design — fetch/db work shouldn't be abandoned).
      if (firstError !== null) {
        return;
      }
      const i = nextIndex++;
      if (i >= items.length) {
        return;
      }
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        if (firstError === null) {
          firstError = error;
        }
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let k = 0; k < safeConcurrency; k++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (firstError !== null) {
    throw firstError;
  }
  return results;
}
