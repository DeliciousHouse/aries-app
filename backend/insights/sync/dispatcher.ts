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
 *   - The interval worker (backend/insights/worker.ts, Phase 4) — trigger 'interval'
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
import { isSupportedPlatform } from '../platforms/registry';
import { getAdapter } from './adapter-factory';
import type { DateRange } from '../adapters/_adapter.types';
import type { SyncTrigger, SyncStatus } from '../types';

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
): Promise<SyncResult> {
  const client = await pool.connect();
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
    const adapter = getAdapter(platform);
    const range30 = lastNDaysRange(30);

    let postsSeen = 0;
    let commentsSeen = 0;
    let apiUnitsUsed = 0;

    // 3. Post list
    const rawPosts = await adapter.fetchPostList(externalAccountId);
    apiUnitsUsed++;

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
    const accountMetrics = await adapter.fetchAccountMetrics(externalAccountId, range30);
    apiUnitsUsed++;

    for (const m of accountMetrics) {
      await client.query(
        `INSERT INTO insights_account_metrics_daily
           (tenant_id, account_id, platform, date,
            views, watch_time_minutes, followers, followers_delta,
            likes, comments_count, shares,
            platform_data, raw_source)
         VALUES ($1, $2, $3, $4,
                 $5, $6, $7, $8,
                 $9, $10, $11,
                 '{}', $12)
         ON CONFLICT (tenant_id, account_id, date) DO NOTHING`,
        [
          tenantId, accountId, platform, m.date,
          m.views, m.watchTimeMinutes, m.followers, m.followersDelta,
          m.likes, m.commentsCount, m.shares,
          JSON.stringify(m.rawSource),
        ],
      );
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
    }

    // ── 7. Finish sync_run record + update account ─────────────────────────
    await client.query(
      `UPDATE insights_sync_runs
       SET status        = 'ok',
           finished_at   = now(),
           posts_seen    = $1,
           comments_seen = $2,
           api_units_used = $3
       WHERE id = $4`,
      [postsSeen, commentsSeen, apiUnitsUsed, syncRunId],
    );

    await client.query(
      `UPDATE insights_accounts SET last_sync_at = now() WHERE id = $1`,
      [accountId],
    );

    return {
      syncRunId, accountId, platform,
      status: 'ok',
      postsSeen, commentsSeen, apiUnitsUsed,
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
