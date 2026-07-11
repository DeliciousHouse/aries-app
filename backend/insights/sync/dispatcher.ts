/**
 * backend/insights/sync/dispatcher.ts
 *
 * Sync coordinator for the insights module.
 *
 * Two public functions:
 *   syncAccountForTenant(tenantId, accountId, trigger)
 *     — syncs one account; writes a sync_run record; returns a SyncResult.
 *
 *   syncAllAccountsForTenant(tenantId, trigger)
 *     — loads all accounts for a tenant and calls syncAccountForTenant for each.
 *
 * Called by:
 *   - The interval worker (scripts/automations/insights-sync-worker.ts) — trigger 'interval'
 *   - The API handler (app/api/integrations/handlers.ts, Phase 5) — trigger 'handler'
 *   - A one-off backfill script — trigger 'backfill'
 *
 * Design notes:
 *   - No wrapping transaction. Each upsert commits independently so a partial
 *     sync still persists useful data if the adapter fails mid-run.
 *   - Errors from the adapter are caught, logged to insights_sync_runs, and
 *     returned as status='failed'. They do NOT propagate to the caller.
 *   - During Phase 3 (adapter stubs), every sync will return status='failed'
 *     with "not implemented". That is expected. The seeded data in the DB is
 *     untouched. The read-path API (Phase 7) reads the DB directly.
 */

import pool from '@/lib/db';
import { isSupportedPlatform, type Platform } from '../platforms/registry';
import { getAdapter } from './adapter-factory';
import { classifyCommentsWithHermes, isCommentClassificationEnabled, MAX_CLASSIFY_BATCH } from './classify-comments';
import type { DateRange, InsightsAdapter, InsightsAdapterContext } from '../adapters/_adapter.types';
import type { SyncTrigger, SyncStatus } from '../types';
import { getConnectionRow } from '@/backend/integrations/composio/connection-store';
import { isIntegrationPlatform } from '@/backend/integrations/providers/types';

// ── Injection seam (production defaults to the global pool + real factory) ──────
// Lets the leg-isolation regression test drive syncAccountForTenant against an
// in-memory fake pool + adapter, with no live database. Production callers never
// pass deps.
interface SyncClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(): void;
}
interface SyncPool {
  connect(): Promise<SyncClient>;
}
export interface SyncDeps {
  pool?: SyncPool;
  resolveAdapter?: (platform: Platform, ctx: InsightsAdapterContext) => InsightsAdapter;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Returns a DateRange covering the last `days` days (inclusive of today). */
function lastNDaysRange(days: number): DateRange {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from: toDateStr(from), to: toDateStr(to) };
}

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Terminal ok-path UPDATE for a sync run. Exported so the requires-infra
 * sweep test (tests/insights-sync-runs-sweep.requires-infra.test.ts) executes
 * this exact statement. `error_message = NULL` is load-bearing: a run swept by
 * sweepAbandonedSyncRuns mid-flight that then completes must not keep the
 * sweep's 'aborted by worker restart' message on a status='ok' row.
 * $1 posts_seen, $2 comments_seen, $3 api_units_used, $4 id.
 */
export const SYNC_RUN_TERMINAL_OK_SQL = `
  UPDATE insights_sync_runs
  SET status        = 'ok',
      finished_at   = now(),
      posts_seen    = $1,
      comments_seen = $2,
      api_units_used = $3,
      error_message = NULL
  WHERE id = $4
`;

export interface SyncResult {
  syncRunId: number;
  accountId: number;
  platform: string;
  status: SyncStatus;
  postsSeen: number;
  commentsSeen: number;
  apiUnitsUsed: number;
  errorMessage?: string;
}

// ── Core sync ─────────────────────────────────────────────────────────────────

/**
 * Syncs a single insights_account row.
 *
 * Steps:
 *   1. Load account from DB; validate platform is supported.
 *   2. Insert a sync_run record (status='running').
 *   3. Fetch & upsert post list.
 *   4. Fetch & upsert account-level daily metrics (last 30 days).
 *   5. Fetch & upsert per-post daily metrics for posts due a refresh.
 *   6. Fetch & upsert comments for posts published in the last 30 days.
 *   7. Mark sync_run as 'ok'; update account.last_sync_at.
 *
 * Any adapter error marks the sync_run as 'failed' and returns gracefully.
 */
export async function syncAccountForTenant(
  tenantId: number,
  accountId: number,
  trigger: SyncTrigger = 'handler',
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const db: SyncPool = deps.pool ?? (pool as unknown as SyncPool);
  const resolveAdapter = deps.resolveAdapter ?? getAdapter;
  const client = await db.connect();
  let syncRunId = -1;
  let platform = 'unknown';

  try {
    // ── 1. Load account ────────────────────────────────────────────────────
    const accountRes = await client.query<{
      id: number;
      platform: string;
      external_account_id: string;
    }>(
      `SELECT id, platform, external_account_id
       FROM insights_accounts
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [accountId, tenantId],
    );

    if ((accountRes.rowCount ?? 0) === 0) {
      throw new Error(
        `insights_account id=${accountId} not found for tenant ${tenantId}`,
      );
    }

    const account = accountRes.rows[0];
    platform = account.platform;
    const externalAccountId = account.external_account_id;

    if (!isSupportedPlatform(platform)) {
      throw new Error(`Unsupported platform: "${platform}"`);
    }

    // ── 2. Open sync_run record ────────────────────────────────────────────
    const runRes = await client.query<{ id: number }>(
      `INSERT INTO insights_sync_runs
         (tenant_id, account_id, platform, trigger, started_at, status)
       VALUES ($1, $2, $3, $4, now(), 'running')
       RETURNING id`,
      [tenantId, accountId, platform, trigger],
    );
    syncRunId = runRes.rows[0].id;

    // ── 3–6. Call adapter ──────────────────────────────────────────────────
    // Composio-backed adapters (Facebook) need the per-tenant Composio
    // connectedAccountId; resolve it from the connection store (reusing this
    // pooled client). YouTube ignores the context. A missing/failed lookup
    // leaves the context empty so the adapter surfaces a clear error.
    let connectedAccountId: string | null = null;
    if (isIntegrationPlatform(platform)) {
      const conn = await getConnectionRow(String(tenantId), platform, client).catch(() => null);
      connectedAccountId = conn?.connectedAccountId ?? null;
    }
    const adapter = resolveAdapter(platform, { tenantId, connectedAccountId, pageId: externalAccountId });
    const range30 = lastNDaysRange(30);

    let postsSeen = 0;
    let commentsSeen = 0;
    let apiUnitsUsed = 0;
    // Each adapter leg below is isolated: one platform call failing (e.g. a
    // POST_INSIGHTS error for one post) is recorded here and the remaining legs
    // still run + persist. A non-empty list downgrades the run to 'partial'
    // instead of failing the whole sync — so #597 comments can never be zeroed
    // by a #596 metrics error, and vice-versa.
    const legErrors: string[] = [];

    // 3. Post list
    let rawPosts: Awaited<ReturnType<typeof adapter.fetchPostList>> = [];
    try {
      rawPosts = await adapter.fetchPostList(externalAccountId);
      apiUnitsUsed++;
    } catch (err) {
      legErrors.push(`fetchPostList: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const rp of rawPosts) {
      await client.query(
        `INSERT INTO insights_posts
           (tenant_id, account_id, platform, external_post_id,
            published_at, media_type, title, caption, permalink,
            duration_seconds, platform_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, platform, external_post_id)
           DO UPDATE SET
             title         = EXCLUDED.title,
             caption       = EXCLUDED.caption,
             platform_data = EXCLUDED.platform_data`,
        [
          tenantId, accountId, platform, rp.externalPostId,
          rp.publishedAt, rp.mediaType,
          rp.title, rp.caption, rp.permalink,
          rp.durationSeconds,
          // thumbnail_url has no dedicated column — stored in platform_data
          JSON.stringify({ thumbnailUrl: rp.thumbnailUrl }),
        ],
      );
      postsSeen++;
    }

    // 4. Account-level daily metrics (last 30 days)
    try {
      const accountMetrics = await adapter.fetchAccountMetrics(externalAccountId, range30);
      apiUnitsUsed++;

      for (const m of accountMetrics) {
        await client.query(
          `INSERT INTO insights_account_metrics_daily
             (tenant_id, account_id, platform, date,
              views, watch_time_minutes, followers, followers_delta,
              likes, comments_count, shares, engagement,
              platform_data, raw_source)
           VALUES ($1, $2, $3, $4,
                   $5, $6, $7, $8,
                   $9, $10, $11, $12,
                   '{}', $13)
           -- S2-2 (AA-93): intraday upsert. Sync runs ~every 30 min; the first
           -- run of a calendar day inserted the row and every later same-day run
           -- was discarded by DO NOTHING, freezing the day's row at its earliest
           -- value. DO UPDATE refreshes the row to each later sync's latest value.
           -- Only value columns this INSERT provides are updated (via EXCLUDED);
           -- reach/profile_visits/saves are NOT written here so are omitted (their
           -- EXCLUDED is NULL and would clobber any other writer); the conflict key
           -- (tenant_id, account_id, date) is never touched. This table holds
           -- genuine daily values (not cumulative snapshots), so the account half
           -- is safe independently of the per-post S2-1 latest-snapshot fix.
           ON CONFLICT (tenant_id, account_id, date) DO UPDATE SET
             views              = EXCLUDED.views,
             watch_time_minutes = EXCLUDED.watch_time_minutes,
             followers          = EXCLUDED.followers,
             followers_delta    = EXCLUDED.followers_delta,
             likes              = EXCLUDED.likes,
             comments_count     = EXCLUDED.comments_count,
             shares             = EXCLUDED.shares,
             engagement         = EXCLUDED.engagement,
             raw_source         = EXCLUDED.raw_source`,
          [
            tenantId, accountId, platform, m.date,
            m.views, m.watchTimeMinutes, m.followers, m.followersDelta,
            m.likes, m.commentsCount, m.shares, m.engagement ?? null,
            JSON.stringify(m.rawSource),
          ],
        );
      }
    } catch (err) {
      legErrors.push(`fetchAccountMetrics: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Per-post daily metrics
    //    Only posts that are at least 1 day old and haven't been refreshed in 6 hours.
    const postsToSync = await client.query<{
      id: number;
      external_post_id: string;
    }>(
      `SELECT id, external_post_id
       FROM insights_posts
       WHERE tenant_id = $1
         AND account_id = $2
         AND published_at < now() - INTERVAL '1 day'
         AND (
           last_metrics_fetched_at IS NULL
           OR last_metrics_fetched_at < now() - INTERVAL '6 hours'
         )
       ORDER BY published_at DESC
       LIMIT 50`,
      [tenantId, accountId],
    );

    for (const post of postsToSync.rows) {
      try {
        const postMetrics = await adapter.fetchPostMetrics(post.external_post_id, range30);
        apiUnitsUsed++;

        for (const pm of postMetrics) {
          await client.query(
            `INSERT INTO insights_post_metrics_daily
               (tenant_id, post_id, platform, date,
                views, watch_time_minutes,
                avg_view_duration_sec, avg_view_percentage,
                likes, comments_count, shares,
                platform_data, raw_source)
             VALUES ($1, $2, $3, $4,
                     $5, $6, $7, $8,
                     $9, $10, $11,
                     '{}', $12)
             ON CONFLICT (tenant_id, post_id, date) DO NOTHING`,
            [
              tenantId, post.id, platform, pm.date,
              pm.views, pm.watchTimeMinutes,
              pm.avgViewDurationSec, pm.avgViewPercentage,
              pm.likes, pm.commentsCount, pm.shares,
              JSON.stringify(pm.rawSource),
            ],
          );
        }

        await client.query(
          `UPDATE insights_posts SET last_metrics_fetched_at = now() WHERE id = $1`,
          [post.id],
        );
      } catch (err) {
        // One post's metrics failing must not skip the rest of the loop OR the
        // comments leg below.
        legErrors.push(
          `fetchPostMetrics(${post.external_post_id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 6. Comments — last 30 days of posts, up to 100 comments per post
    const recentPosts = await client.query<{
      id: number;
      external_post_id: string;
    }>(
      `SELECT id, external_post_id
       FROM insights_posts
       WHERE tenant_id = $1
         AND account_id = $2
         AND published_at > now() - INTERVAL '30 days'
       ORDER BY published_at DESC
       LIMIT 20`,
      [tenantId, accountId],
    );

    for (const post of recentPosts.rows) {
      try {
        const comments = await adapter.fetchComments(post.external_post_id, 100);
        apiUnitsUsed++;

        for (const c of comments) {
          await client.query(
            `INSERT INTO insights_comments
               (tenant_id, post_id, platform, external_comment_id,
                received_at, author_handle, body_text, platform_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')
             ON CONFLICT (tenant_id, platform, external_comment_id) DO NOTHING`,
            [
              tenantId, post.id, platform, c.externalCommentId,
              c.receivedAt, c.authorHandle, c.bodyText,
            ],
          );
          commentsSeen++;
        }
      } catch (err) {
        legErrors.push(
          `fetchComments(${post.external_post_id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── 6b. Classify newly-seen comments (sentiment / lead / category) ──────
    // Best-effort + gated. A batch of unclassified comments for this account is
    // sent to a raw Hermes run; results land in insights_comment_classifications
    // (which powers Conversations sentiment/lead-quality + the goal lead count).
    // Bounded to one batch per account per tick, so it converges over ticks
    // without extending the tick unboundedly. A failure is isolated to legErrors.
    if (isCommentClassificationEnabled(process.env)) {
      try {
        const unclassified = await client.query<{ id: number; body_text: string }>(
          `SELECT c.id, c.body_text
             FROM insights_comments c
             JOIN insights_posts p
               ON p.id = c.post_id AND p.tenant_id = c.tenant_id
             LEFT JOIN insights_comment_classifications cl ON cl.comment_id = c.id
            WHERE c.tenant_id  = $1
              AND p.account_id = $2
              AND cl.comment_id IS NULL
              AND c.received_at > now() - INTERVAL '30 days'
            ORDER BY c.received_at DESC
            LIMIT $3`,
          [tenantId, accountId, MAX_CLASSIFY_BATCH],
        );

        if (unclassified.rows.length > 0) {
          const result = await classifyCommentsWithHermes({
            comments: unclassified.rows.map((r) => ({ id: Number(r.id), text: r.body_text })),
          });
          if (result.ok) {
            apiUnitsUsed++;
            for (const [commentId, label] of result.labels) {
              await client.query(
                `INSERT INTO insights_comment_classifications
                   (comment_id, tenant_id, sentiment, is_lead, category, classifier_version, cost_cents)
                 VALUES ($1, $2, $3, $4, $5, 'hermes-comment-v1', 0)
                 ON CONFLICT (comment_id) DO NOTHING`,
                [commentId, tenantId, label.sentiment, label.isLead, label.category],
              );
            }
          } else if (result.reason !== 'disabled' && result.reason !== 'empty_input') {
            legErrors.push(`classifyComments: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
          }
        }
      } catch (err) {
        legErrors.push(`classifyComments: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 7. Finish sync_run record + update account ─────────────────────────
    // A leg that threw is isolated (captured in legErrors) and downgrades the
    // run to 'partial' — the legs that succeeded still persisted. Only a clean
    // run takes the 'ok' fast path (which also clears any mid-flight sweep abort
    // message via SYNC_RUN_TERMINAL_OK_SQL).
    const status: SyncStatus = legErrors.length > 0 ? 'partial' : 'ok';
    if (status === 'ok') {
      await client.query(SYNC_RUN_TERMINAL_OK_SQL, [
        postsSeen,
        commentsSeen,
        apiUnitsUsed,
        syncRunId,
      ]);
    } else {
      await client.query(
        `UPDATE insights_sync_runs
         SET status = 'partial', finished_at = now(),
             posts_seen = $1, comments_seen = $2, api_units_used = $3,
             error_message = $4
         WHERE id = $5`,
        [postsSeen, commentsSeen, apiUnitsUsed, legErrors.join(' | ').slice(0, 2000), syncRunId],
      );
    }

    await client.query(
      `UPDATE insights_accounts SET last_sync_at = now() WHERE id = $1`,
      [accountId],
    );

    return {
      syncRunId, accountId, platform,
      status,
      postsSeen, commentsSeen, apiUnitsUsed,
      ...(legErrors.length > 0 ? { errorMessage: legErrors.join(' | ') } : {}),
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Best-effort: mark sync_run as failed (don't let this secondary write throw)
    if (syncRunId !== -1) {
      await client
        .query(
          `UPDATE insights_sync_runs
           SET status = 'failed', finished_at = now(), error_message = $1
           WHERE id = $2`,
          [errorMessage, syncRunId],
        )
        .catch(() => {
          // intentionally silent — primary error is more important
        });
    }

    return {
      syncRunId, accountId, platform,
      status: 'failed',
      postsSeen: 0,
      commentsSeen: 0,
      apiUnitsUsed: 0,
      errorMessage,
    };

  } finally {
    client.release();
  }
}

/**
 * Syncs all insights_accounts for a tenant, one by one.
 * Returns an array of SyncResult (one per account).
 *
 * Errors per account are captured in each SyncResult; one failure
 * does not prevent the rest from running.
 */
export async function syncAllAccountsForTenant(
  tenantId: number,
  trigger: SyncTrigger = 'interval',
): Promise<SyncResult[]> {
  // Load account IDs in a short-lived connection, then release
  const client = await pool.connect();
  let accounts: Array<{ id: number; platform: string }> = [];
  try {
    const res = await client.query<{ id: number; platform: string }>(
      `SELECT id, platform FROM insights_accounts WHERE tenant_id = $1`,
      [tenantId],
    );
    accounts = res.rows;
  } finally {
    client.release();
  }

  const results: SyncResult[] = [];
  for (const account of accounts) {
    const result = await syncAccountForTenant(tenantId, account.id, trigger);
    results.push(result);
  }
  return results;
}
