// ─────────────────────────────────────────────────────────────────────────────
// useInsight.ts — Generic fetch hook for all /api/insights/* endpoints
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import type { Period, Platform } from "@/frontend/insights/types";

export interface UseInsightResult<T> {
  data:    T | null;
  loading: boolean;
  error:   string | null;
  /** Call to force-refresh (bypasses 1-hour server cache). */
  refetch: () => void;
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

export function useInsight<T>(
  section:  string,
  period:   Period,
  platform: Platform,
  extra:    Record<string, string> = {},
): UseInsightResult<T> {
  const [data, setData]       = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Monotonic counter — lets us ignore responses from stale requests
  const tick = useRef(0);

  const run = useCallback(
    async (force = false) => {
      const id = ++tick.current;
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          period,
          platform,
          ...extra,
          ...(force ? { force: "true" } : {}),
        });

        const res = await fetch(`/api/insights/${section}?${params}`);

        if (res.status === 401) throw new Error("Session expired — please log in again.");

        // AA-120: the server bounds forced rebuilds (?force=true) per tenant and
        // section. A 429 does not mean the section is broken — it means this
        // refresh arrived too soon — so it earns its own message carrying the
        // real remaining cooldown rather than a bare "Server error (429)".
        // Note `data` is deliberately left untouched (setData only runs on
        // success), so a populated panel keeps whatever it was already showing.
        if (res.status === 429) {
          const seconds = await retryAfterSeconds(res);
          throw new Error(
            seconds === null
              ? "Refreshing too fast — give it a moment and try again."
              : `Refreshing too fast — try again in ${seconds}s.`,
          );
        }

        if (!res.ok)            throw new Error(`Server error (${res.status})`);

        const json = await res.json();
        if (json.status === 400) throw new Error(json.error ?? "Bad request");

        if (id === tick.current) setData(json as T);
      } catch (e: unknown) {
        if (id === tick.current)
          setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (id === tick.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section, period, platform, JSON.stringify(extra)],
  );

  useEffect(() => { run(); }, [run]);

  return { data, loading, error, refetch: () => run(true) };
}
