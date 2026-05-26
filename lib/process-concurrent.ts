/**
 * Bounded-concurrency map. Processes `items` with `fn` running up to
 * `concurrency` calls in flight at any time. Returns results in the same
 * order as `items` (so callers can replace `for…of` serial loops without
 * having to add an explicit sort).
 *
 * Why this exists: dashboard endpoints (`/api/marketing/reviews`,
 * `/api/marketing/campaigns`) iterated the per-tenant job list serially,
 * doing `await loadMarketingJobRuntime` + `await getMarketingJobStatus` +
 * `await buildCampaignWorkspaceView` + `await buildReviewItemsForJob` for
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
 * Errors propagate via Promise.allSettled-style rejection: the first
 * rejection cancels nothing else but is re-thrown after all in-flight
 * work resolves. Callers that need partial results on error should
 * catch in `fn` instead.
 */
export async function processConcurrent<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<U>,
  concurrency: number,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }
  const safeConcurrency = Math.max(1, Math.min(Math.floor(concurrency), items.length));
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
