/**
 * Hermes run reconciler worker — spawned by start-runtime.mjs when
 * ARIES_RECONCILER_ENABLED is not 0/false (default ON).
 *
 * Durable replacement for the in-process poll-bridge: every
 * ARIES_RECONCILER_INTERVAL_MS (default 60s) it re-discovers in-flight marketing
 * execution runs from disk and drives any that Hermes has finished to terminal
 * via the idempotent callback handler. Runs inside the aries-app container as a
 * sibling of the Next.js cluster (like the stale-run reaper), so it inherits the
 * shared /data volume, every HERMES_* gateway, the image-cache mount, and the
 * file locks the in-process callback path uses.
 *
 * The 60s default comfortably beats the stale-run reaper's tightest stage
 * threshold (strategy = 5 min) and the research budget (10 min), while Hermes
 * itself finishes stages in ~1-11 min — so completed runs are ingested well
 * before the reaper would fail the job.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';

import { runHermesReconciler } from '@/backend/marketing/hermes-reconciler';

const DEFAULT_INTERVAL_MS = 60 * 1000; // 60 seconds
const DEFAULT_TICK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — a healthy sweep is seconds
const TICK_TIMEOUT = Symbol('hermes-reconciler-tick-timeout');

function resolveIntervalMs(): number {
  const raw = process.env.ARIES_RECONCILER_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function resolveTickTimeoutMs(): number {
  const raw = process.env.ARIES_RECONCILER_TICK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TICK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  // 0 disables the watchdog.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TICK_TIMEOUT_MS;
}

function reconcilerEnabled(): boolean {
  const v = process.env.ARIES_RECONCILER_ENABLED?.trim().toLowerCase();
  // Default ON: this is the durable fix for the poll-bridge outage. Disable
  // only with an explicit 0/false/no/off.
  if (!v) return true;
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn('[hermes-reconciler] previous tick still running; skipping');
    return;
  }
  running = true;
  const timeoutMs = resolveTickTimeoutMs();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  try {
    const sweep = runHermesReconciler();
    const result =
      timeoutMs > 0
        ? await Promise.race<typeof TICK_TIMEOUT | Awaited<typeof sweep>>([
            sweep,
            new Promise((resolve) => {
              watchdog = setTimeout(() => resolve(TICK_TIMEOUT), timeoutMs);
            }),
          ])
        : await sweep;

    if (result === TICK_TIMEOUT) {
      // The sweep never returned — a wedged ingestion (e.g. a hung DB query)
      // would otherwise leave `running` true and skip every future tick with no
      // respawn (the process stays alive). Exit non-zero so start-runtime spawns
      // a fresh worker; the abandoned sweep's per-run lock self-clears via the
      // run-store stale-lock reclaim.
      console.error(`[hermes-reconciler] tick exceeded ${timeoutMs}ms; exiting for respawn`);
      process.exit(1);
    }

    const report = result;
    // Log on any in-flight activity (candidates>0), not just ingests/errors, so
    // the scanned count (a proxy for execution-run file growth) and the live
    // in-flight backlog are observable. Silent when fully idle.
    if (report.ingested > 0 || report.errors > 0 || report.candidates > 0) {
      console.log(
        `[hermes-reconciler] scanned=${report.scanned} candidates=${report.candidates} ingested=${report.ingested} pending=${report.pending} skipped=${report.skipped} errors=${report.errors}`,
      );
      for (const d of report.details) {
        console.log(
          `[hermes-reconciler] ${d.outcome} ariesRunId=${d.ariesRunId}${d.detail ? ` detail=${d.detail}` : ''}`,
        );
      }
    }
  } catch (err) {
    console.error('[hermes-reconciler] tick failed', err);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    running = false;
  }
}

async function main(): Promise<void> {
  if (!reconcilerEnabled()) {
    console.log('[hermes-reconciler] ARIES_RECONCILER_ENABLED is off; exiting.');
    process.exit(0);
  }

  const intervalMs = resolveIntervalMs();
  console.log(`[hermes-reconciler] starting; interval=${intervalMs}ms`);

  await tick();

  if (process.env.ARIES_RECONCILER_RUN_ONCE?.trim() === '1') {
    process.exit(0);
  }

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(handle);
      process.exit(0);
    });
  }
}

// Only self-start when run directly as the worker entrypoint, not when imported
// by a test (the honcho worker added this guard after a filename-substring check
// matched the *.test.ts importer and booted the loop under the test runner).
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main();
}
