/**
 * P2 — honcho-performance-worker
 *
 * Delayed, metric-bearing Honcho write leg for published Meta posts. 24h..30d
 * after publish, reads #513-E's stored `insights_post_metrics_daily` snapshot
 * (NEVER fetches Meta — see the #513 boundary in
 * docs/plans/2026-05-30-honcho-performance-insights.md), scrubs platform IDs,
 * and calls the already-shipped `recordPerformanceEvent` to write a
 * `research_conclusion` to `peer-market-signal-<topicPseudonym>`.
 *
 * Run as a sidecar via `tsx scripts/automations/honcho-performance-worker.ts`
 * (mirrors scheduled-posts-worker.mjs's tick/finally + setInterval pattern, but
 * is TS so it can import the TS write surface directly). `runTick` is exported
 * for the integration tests; `main()` self-schedules at 30-min intervals.
 *
 * Gate: HONCHO_WRITE_PUBLISH_ENABLED. `recordPerformanceEvent` self-gates and
 * no-ops when off; the worker also reads the gate to decide whether to ledger,
 * so flipping the gate ON later re-drives the writes.
 *
 * #513-GATED: until #513-A/E land, `selectDuePerformancePosts` returns [] (see
 * insights-513-contract.ts) so the worker boots and ticks as a harmless no-op.
 */

import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  selectDuePerformancePosts,
  selectTenantsWithDuePosts,
  markHonchoPerfWritten,
  type Queryable,
} from '@/backend/memory/perf-insights-read';
import { buildPerformancePayloadRecord } from '@/backend/memory/perf-insights-payload';
import {
  recordPerformanceEvent,
  topicPseudonymHexForPerformanceMemory,
} from '@/backend/memory/write-events';
import { loadSocialContentJobRuntime } from '@/backend/marketing/runtime-state';
import { isHonchoEnabled, isHonchoWritePublishEnabled } from '@/backend/memory/honcho-env';
import { parsePoolMax, WORKER_POOL_MAX } from '@/lib/db-pool-config';
import type { TenantRole } from '@/lib/tenant-context';

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let running = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function buildPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    // Dedicated small pool, NOT the app pool (guardrail #1 — keep worker DB
    // pressure off the request path).
    max: parsePoolMax(process.env.DB_POOL_MAX, WORKER_POOL_MAX),
  });
}

export interface TickReport {
  tenantsScanned: number;
  due: number;
  written: number;
  skippedNoDoc: number;
  skippedNoPayload: number;
  failed: number;
}

/**
 * One tick. Per tenant, per due post: load runtime doc, build payload, write to
 * Honcho via recordPerformanceEvent, ledger on success. Per-post and per-tenant
 * try/catch so one bad row/tenant never aborts the batch (resumability — partial
 * progress preserved; CLAUDE.md). Exported for integration tests.
 *
 * `deps` lets tests inject mocks; defaults are the real functions.
 */
export async function runTick(
  client: Queryable,
  deps: {
    loadDoc?: typeof loadSocialContentJobRuntime;
    record?: typeof recordPerformanceEvent;
    markWritten?: typeof markHonchoPerfWritten;
    gateEnabled?: () => boolean;
  } = {},
): Promise<TickReport> {
  const loadDoc = deps.loadDoc ?? loadSocialContentJobRuntime;
  const record = deps.record ?? recordPerformanceEvent;
  const markWritten = deps.markWritten ?? markHonchoPerfWritten;
  // Gate read: only ledger when the Honcho write would actually fire. When the
  // gate is OFF, recordPerformanceEvent no-ops AND we skip the ledger, so
  // flipping the gate ON later re-drives every due write.
  const gateEnabled = deps.gateEnabled ?? (() => isHonchoEnabled() && isHonchoWritePublishEnabled());

  const report: TickReport = {
    tenantsScanned: 0,
    due: 0,
    written: 0,
    skippedNoDoc: 0,
    skippedNoPayload: 0,
    failed: 0,
  };

  const gateOn = gateEnabled();

  let tenants: number[] = [];
  try {
    tenants = await selectTenantsWithDuePosts(client);
  } catch (err) {
    console.error('[honcho-performance-worker] tenant scan failed', err);
    return report;
  }

  for (const tenantId of tenants) {
    report.tenantsScanned += 1;
    try {
      const due = await selectDuePerformancePosts(tenantId, client);
      report.due += due.length;

      for (const post of due) {
        try {
          const doc = await loadDoc(post.jobId);
          if (!doc) {
            report.skippedNoDoc += 1;
            console.warn(
              `[honcho-performance-worker] no runtime doc for job=${post.jobId} tenant=${tenantId}; skipping`,
            );
            continue;
          }

          const payloadRecord = buildPerformancePayloadRecord({
            platform: post.platform,
            publishDayYmd: post.publishDay,
            metricsRow: post.metrics,
            sourceUrl: post.permalink,
            fetchedAt: new Date().toISOString(),
          });
          if (!payloadRecord) {
            // No https source / unparseable publish day — fail-soft, no ledger
            // (mirrors recordPerformanceEvent's own guard).
            report.skippedNoPayload += 1;
            continue;
          }

          const topicPseudonymHex = topicPseudonymHexForPerformanceMemory(
            post.jobId,
            doc.inputs?.competitor_url ?? null,
          );
          const tenantIdStr = String(doc.tenant_id);
          const tenantCtx = {
            tenantId: tenantIdStr,
            tenantSlug: doc.tenant_id ? `tenant-${tenantIdStr}` : 'tenant-unknown',
            // SYNTHETIC context: never the tenantId-as-userId (a user N in
            // tenant N would collide in pseudonymForUser under
            // multi-workspace; plan Taste/Honcho verification hardening).
            // recordPerformanceEvent never reads ctx.userId.
            userId: 'system',
            role: 'tenant_admin' as TenantRole,
          };
          // published_at_ymd is YYYY-MM-DD from the builder; recordPerformanceEvent
          // wants compact YYYYMMDD for its idempotency key.
          const publishedAtYmd = payloadRecord.published_at_ymd.replace(/-/g, '');

          await record(
            {
              tenantCtx,
              jobId: post.jobId,
              topicPseudonymHex,
              publishedAtYmd,
              platform: post.platform,
              payloadRecord: payloadRecord as unknown as Record<string, unknown>,
            },
          );

          // Ledger only when the gate is ON (so a gate-OFF run leaves nothing to
          // re-drive once it flips ON). metric_day = the post's publish day.
          if (gateOn) {
            await markWritten(tenantId, post.jobId, post.platform, post.metrics.day, client);
            report.written += 1;
          }
        } catch (postErr) {
          report.failed += 1;
          console.error(
            `[honcho-performance-worker] post error job=${post.jobId} tenant=${tenantId}`,
            postErr,
          );
        }
      }
    } catch (tenantErr) {
      report.failed += 1;
      console.error(`[honcho-performance-worker] tenant error tenant=${tenantId}`, tenantErr);
    }
  }

  return report;
}

async function tickSafe(pool: Pool): Promise<void> {
  if (running) {
    console.warn('[honcho-performance-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const report = await runTick(pool as unknown as Queryable);
    if (report.due > 0 || report.failed > 0) {
      console.log(`[honcho-performance-worker] summary ${JSON.stringify(report)}`);
    }
  } catch (error) {
    console.error('[honcho-performance-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  const pool = buildPool();
  console.log(`[honcho-performance-worker] starting; interval=${INTERVAL_MS}ms`);

  await tickSafe(pool);

  if (process.env.ARIES_HONCHO_PERF_RUN_ONCE?.trim() === '1') {
    await pool.end();
    process.exit(0);
  }

  intervalHandle = setInterval(() => void tickSafe(pool), INTERVAL_MS);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      if (intervalHandle) clearInterval(intervalHandle);
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

// Only self-start when run directly as the sidecar entrypoint, not when
// imported by a test. Compare the resolved entrypoint to this module's own URL
// (a substring check on the filename would also match the *.test.ts importer,
// which booted main() against a real DB during the unit test).
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
