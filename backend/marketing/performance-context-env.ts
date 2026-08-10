/**
 * Rollout switch for the weekly performance context block
 * (`backend/marketing/performance-context.ts`).
 *
 * ON (default): before a research or strategy submission, the tenant's own
 * last-28-day post performance (top/bottom posts by engagement) and 4-week
 * follower trend are composed into a compact text block, injected into the
 * STRATEGY prompt beside "Prior stage output", and a 2-line condensed version
 * is added to the weekly research request as `input.recent_performance`.
 *
 * OFF: both the strategy prompt and the weekly request JSON are byte-identical
 * to pre-change — the prompt push is guarded and the request field is a
 * conditional spread — and zero `insights_*` queries are issued.
 *
 * Default ON (unlike ARIES_AI_POSTING_TIMES_ENABLED) because the block is
 * purely additive and fail-open: a tenant with no `insights_*` rows gets no
 * block at all, and any load error degrades to "no block" rather than an
 * error. Set `ARIES_PERF_CONTEXT_ENABLED=0` to kill it.
 *
 * Treat 0/false/no/off as disabled — the inverse of the default-OFF idiom,
 * matching scripts/hermes-reconciler-worker.ts. Process-wide.
 */

type Env = Partial<Record<string, string | undefined>>;

export function isPerfContextEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_PERF_CONTEXT_ENABLED?.trim().toLowerCase();
  if (!v) return true;
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}
