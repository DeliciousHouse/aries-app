/**
 * Stale-run reaper worker — spawned by start-runtime.mjs when
 * ARIES_REAPER_ENABLED=1.  Sweeps marketing-job runtime docs every
 * ARIES_REAPER_INTERVAL_MS (default 5 min) and marks stalled jobs
 * failed_stale via the same logic as `tsx scripts/reap-stale-runs.ts --apply`.
 */
import 'dotenv/config';

import { resolveDataRoot } from '@/lib/runtime-paths';
import { runStaleRunReaper } from '@/backend/marketing/stale-run-reaper';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function resolveIntervalMs(): number {
  const raw = process.env.ARIES_REAPER_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function tick(): Promise<void> {
  const dataRoot = resolveDataRoot();
  try {
    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
    });
    if (report.mutated > 0 || report.errors > 0) {
      console.log(
        `[stale-run-reaper] scanned=${report.scanned} mutated=${report.mutated} skipped=${report.skipped} errors=${report.errors}`,
      );
      for (const c of report.candidates) {
        if (c.mutated) {
          console.log(
            `[stale-run-reaper] reaped jobId=${c.jobId} tenantId=${c.tenantId} stage=${c.stage} silentMs=${c.silentMs}`,
          );
        }
      }
    }
  } catch (err) {
    console.error('[stale-run-reaper] tick failed', err);
  }
}

async function main(): Promise<void> {
  const enabled = process.env.ARIES_REAPER_ENABLED?.trim();
  if (enabled !== '1' && enabled !== 'true') {
    console.log('[stale-run-reaper] ARIES_REAPER_ENABLED is off; exiting.');
    process.exit(0);
  }

  const intervalMs = resolveIntervalMs();
  console.log(`[stale-run-reaper] starting; interval=${intervalMs}ms`);

  await tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}

void main();
