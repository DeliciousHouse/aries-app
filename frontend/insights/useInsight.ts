// ─────────────────────────────────────────────────────────────────────────────
// useInsight.ts — Generic fetch hook for all /api/insights/* endpoints
//
// AA-123 (S7-5, gap D1) — client coalescing. Three problems this hook had:
//
//   1. A superseded request STILL EXECUTED. The `tick` counter only ignored the
//      stale RESPONSE; the server had already done the whole query. Toggling a
//      filter three times ran 27 aggregate queries and used 26 of them for
//      nothing. Now every run carries an AbortController that is fired the
//      moment its inputs change or the component unmounts.
//
//   2. Identical concurrent requests each hit the server. Now they share one
//      in-flight fetch, reference-counted so one consumer leaving cannot cancel
//      a request another is still waiting on.
//
//   3. Everything fetched eagerly. `enabled` lets a caller defer the FETCH
//      until its section is actually in view. It defers the fetch only — never
//      the section's markup; see LazyInsightSection and the AA-152 note there.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import type { Period, Platform } from "@/frontend/insights/types";

export interface UseInsightResult<T> {
  data:    T | null;
  loading: boolean;
  error:   string | null;
  /** Call to force-refresh (bypasses the server cache). */
  refetch: () => void;
}

export interface UseInsightOptions {
  /**
   * When false the hook holds still: no fetch, no loading state. Flipping it to
   * true fetches with whatever the current inputs are — which is what makes
   * "a filter toggle costs only the VISIBLE sections" true. An off-screen
   * section simply picks up the new filter when it is scrolled to.
   */
  enabled?: boolean;
}

/** The normalized outcome of one network attempt, shared by all deduped callers. */
interface InsightFetchOutcome {
  ok: boolean;
  /** Parsed body on success. */
  json?: unknown;
  /** Message to surface when `ok` is false. */
  error?: string;
}

interface InflightRequest {
  controller: AbortController;
  /** How many live consumers are awaiting this exact request. */
  refs: number;
  outcome: Promise<InsightFetchOutcome>;
}

/**
 * In-flight requests keyed by full URL. Module-level so every component in this
 * document shares it — the same scope choice `cache-policy.ts` makes server-side
 * for its singleflight map, and for the same reason: the coalescing only has to
 * cover one process (here, one tab).
 */
const INFLIGHT = new Map<string, InflightRequest>();

/** Test seam — the map is module-global. */
export function __resetInsightInflightForTests(): void {
  for (const entry of INFLIGHT.values()) entry.controller.abort();
  INFLIGHT.clear();
}

/** Test seam — how many distinct requests are currently in flight. */
export function __inflightInsightCountForTests(): number {
  return INFLIGHT.size;
}

/**
 * Remaining cooldown for a 429, in whole seconds, or null when the server did
 * not say. Prefers the JSON body's `retry_after_ms` (exact) and falls back to
 * the `Retry-After` header (already whole seconds). Never throws: a throttle
 * response we cannot parse still has to produce a usable message.
 */
async function retryAfterSeconds(res: Response): Promise<number | null> {
  try {
    const body: unknown = await res.clone().json();
    const ms =
      typeof body === "object" && body !== null
        ? (body as { retry_after_ms?: unknown }).retry_after_ms
        : undefined;
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
      return Math.ceil(ms / 1000);
    }
  } catch {
    // Fall through to the header.
  }

  const header = Number(res.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Perform one request and normalize it. The BODY is parsed here, not by each
 * consumer: a Response body can only be read once, so deduped callers must
 * share the parsed result rather than the Response itself.
 */
async function performFetch(url: string, signal: AbortSignal): Promise<InsightFetchOutcome> {
  const res = await fetch(url, { signal });

  if (res.status === 401) {
    return { ok: false, error: "Session expired — please log in again." };
  }

  // AA-120: the server bounds forced rebuilds (?force=true) per tenant and
  // section. A 429 does not mean the section is broken — it means this refresh
  // arrived too soon — so it earns its own message carrying the real remaining
  // cooldown rather than a bare "Server error (429)".
  if (res.status === 429) {
    const seconds = await retryAfterSeconds(res);
    return {
      ok: false,
      error:
        seconds === null
          ? "Refreshing too fast — give it a moment and try again."
          : `Refreshing too fast — try again in ${seconds}s.`,
    };
  }

  if (!res.ok) return { ok: false, error: `Server error (${res.status})` };

  const json = await res.json();
  if ((json as { status?: unknown })?.status === 400) {
    return { ok: false, error: (json as { error?: string }).error ?? "Bad request" };
  }
  return { ok: true, json };
}

/**
 * Join an in-flight request for `url`, or start one.
 *
 * `dedup: false` (a forced refresh) always starts its own request. Letting a
 * forced refresh piggyback on an in-flight normal one would make the Retry
 * button silently do nothing — it would resolve with the very body the user is
 * trying to replace.
 */
function acquireRequest(url: string, dedup: boolean): InflightRequest {
  if (dedup) {
    const existing = INFLIGHT.get(url);
    if (existing) {
      existing.refs += 1;
      return existing;
    }
  }

  const controller = new AbortController();
  const entry: InflightRequest = {
    controller,
    refs: 1,
    outcome: performFetch(url, controller.signal),
  };

  if (dedup) {
    INFLIGHT.set(url, entry);
    // Stop sharing as soon as it settles, so the next mount fetches fresh data
    // rather than resolving instantly against a completed promise. The catch is
    // required: an aborted request rejects, and an unobserved rejection here
    // would surface as an unhandled rejection.
    void entry.outcome
      .catch(() => undefined)
      .finally(() => {
        if (INFLIGHT.get(url) === entry) INFLIGHT.delete(url);
      });
  }

  return entry;
}

/**
 * Drop one consumer's interest. The underlying request is aborted only when the
 * LAST consumer lets go — otherwise unmounting one section would cancel the
 * request another section is still waiting on.
 */
function releaseRequest(url: string, entry: InflightRequest): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (INFLIGHT.get(url) === entry) INFLIGHT.delete(url);
  entry.controller.abort();
}

export function useInsight<T>(
  section:  string,
  period:   Period,
  platform: Platform,
  extra:    Record<string, string> = {},
  options:  UseInsightOptions = {},
): UseInsightResult<T> {
  const enabled = options.enabled !== false;

  const [data, setData]       = useState<T | null>(null);
  // Start in loading only when we are actually going to fetch; a deferred
  // section must not claim to be loading while it waits to be scrolled to.
  const [loading, setLoading] = useState(enabled);
  const [error, setError]     = useState<string | null>(null);

  // Monotonic counter — ignore the results of superseded runs even after their
  // request has been aborted (an abort is not instantaneous).
  const tick = useRef(0);
  /**
   * The request this hook currently holds a reference to. Without it the
   * cleanup could only invalidate the RESULT — the request itself would still
   * be running, which is precisely the bug this card exists to fix.
   */
  const active = useRef<{ url: string; entry: InflightRequest } | null>(null);

  const releaseActive = useCallback(() => {
    const held = active.current;
    if (!held) return;
    active.current = null;
    releaseRequest(held.url, held.entry);
  }, []);

  const run = useCallback(
    async (force = false) => {
      const id = ++tick.current;
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        period,
        platform,
        ...extra,
        ...(force ? { force: "true" } : {}),
      });
      const url = `/api/insights/${section}?${params}`;

      // Let go of whatever this hook was already waiting on before starting
      // another; a rapid double-toggle must not leak a reference.
      releaseActive();

      const entry = acquireRequest(url, !force);
      active.current = { url, entry };
      try {
        const outcome = await entry.outcome;
        if (id !== tick.current) return;
        if (outcome.ok) setData(outcome.json as T);
        else setError(outcome.error ?? "Unknown error");
      } catch (e: unknown) {
        // An abort is this hook cancelling its own superseded work — never an
        // error the operator should see. Without this guard every filter toggle
        // would flash a failure state.
        if (isAbortError(e)) return;
        if (id === tick.current) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        // Only release what we still hold — the cleanup may have released it
        // first, and a double release would abort an unrelated later request.
        if (active.current?.entry === entry) releaseActive();
        if (id === tick.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section, period, platform, JSON.stringify(extra), releaseActive],
  );

  useEffect(() => {
    if (!enabled) return;
    void run();
    // Superseding this run (inputs changed, or the component went away) aborts
    // it. This is the line that stops a discarded request from finishing its
    // query server-side.
    return () => {
      tick.current += 1;
      releaseActive();
    };
  }, [run, enabled, releaseActive]);

  return { data, loading, error, refetch: () => void run(true) };
}
