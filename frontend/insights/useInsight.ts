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
 * Fetches a single Insights section.
 *
 * @param section   API path segment, e.g. "narrative", "goal", "top"
 * @param period    "week" | "30day" | "90day"
 * @param platform  "all" | "instagram" | "facebook" | "youtube" | "tiktok"
 * @param extra     Any additional query params (e.g. { sort: "reach" })
 *
 * @example
 *   const { data, loading, error, refetch } =
 *     useInsight<NarrativeData>("narrative", period, platform);
 */
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
