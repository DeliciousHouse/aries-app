"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FreshnessStamp.tsx
// "Data as of <timestamp>" indicator for the /insights header, with a stale
// warning state (S1-3 / AA-82). Fetches the UNCACHED /api/insights/freshness
// endpoint on mount and polls every 60s, so a recovering sync clears the stale
// warning without a manual reload. Independent of the cached narrative.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { C } from "@/frontend/insights/tokens";
import { Icon } from "@/frontend/insights/ui";

type FreshnessStatus = "fresh" | "partial" | "stale" | "never_synced";

interface FreshnessData {
  status:   FreshnessStatus;
  dataAsOf: string | null;
}

const POLL_MS = 60_000;

function relativeTime(iso: string, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000));
  if (min < 1)  return "just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

interface Display {
  color:  string;
  label:  string;
  title?: string;
  warn:   boolean;
}

function toDisplay(data: FreshnessData, nowMs: number): Display {
  const rel  = data.dataAsOf ? relativeTime(data.dataAsOf, nowMs) : null;
  const abs  = data.dataAsOf ? new Date(data.dataAsOf).toLocaleString() : undefined;
  switch (data.status) {
    case "fresh":
      return { color: C.t3, label: `Data as of ${rel}`, title: abs, warn: false };
    case "partial":
      return {
        color: C.amber,
        label: `Data as of ${rel} · partial sync`,
        title: "Some metrics may be incomplete — not all sources synced successfully.",
        warn:  true,
      };
    case "stale":
      return {
        color: C.amber,
        label: rel ? `Data may be stale — last updated ${rel}` : "Data may be stale",
        title: abs ? `Last successful sync: ${abs}` : undefined,
        warn:  true,
      };
    case "never_synced":
    default:
      return { color: C.t3, label: "Waiting for first sync…", warn: false };
  }
}

export function FreshnessStamp() {
  const [data, setData] = useState<FreshnessData | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => 0); // 0 until first client tick (SSR-safe)

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/insights/freshness", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as FreshnessData;
        if (alive) { setData(json); setNowMs(Date.now()); }
      } catch {
        /* transient — keep the last good stamp, retry next poll */
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!data || nowMs === 0) return null; // nothing until the first successful fetch

  const d = toDisplay(data, nowMs);
  return (
    <span
      title={d.title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 11.5, color: d.color, whiteSpace: "nowrap",
        border: `1px solid ${d.warn ? `${C.amber}55` : C.border}`,
        background: d.warn ? `${C.amber}14` : "transparent",
        borderRadius: 99, padding: "4px 10px",
      }}
    >
      <Icon name={d.warn ? "info" : "clock"} size={12} color={d.color} />
      {d.label}
    </span>
  );
}
