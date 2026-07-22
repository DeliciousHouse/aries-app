/**
 * Draft-expiry sweep — expires STRANDED pre-publish posts so they stop
 * accumulating when a weekly cron generates content faster than operators
 * approve and ship it.
 *
 * The symptom this exists for: "36 stranded approved IG posts on tenant 15" —
 * posts that were generated/approved but never reached the publish queue and
 * just sat there forever. The dashboard "backlog tray"
 * (app/api/social-content/scheduled-posts UNSCHEDULED_POSTS_QUERY) surfaces
 * exactly this population: approved posts with NO scheduled_posts row. Without a
 * sweep, widening the weekly trigger (Piece B) to many tenants would grow this
 * backlog without bound.
 *
 * A post is a "stranded draft" when ALL of:
 *   - it never reached the publish queue: NO scheduled_posts row
 *     (matches the backlog-tray "sp.id IS NULL" filter);
 *   - it never went live: published_at IS NULL;
 *   - it never reached Meta: platform_post_id IS NULL (so a post scheduled or
 *     published natively on Meta, which leaves the legacy status column at its
 *     'draft' default, is never expired);
 *   - its CANONICAL published_status is pre-publish
 *     ('draft' | 'in_review' | 'approved');
 *   - it has been untouched longer than the age window (updated_at < cutoff).
 *
 * The sweep marks such posts published_status='expired' (and the legacy status
 * column too, so they don't diverge). 'expired' is a terminal pre-publish state:
 * the post is removed from the operator's approval/backlog surfaces without
 * being published (stale content must NOT go out late). It is decoupled from the
 * stale-run reaper, which reaps stranded JOB docs on disk (a different
 * population): the reaper marks awaiting-approval JOBS failed_stale after 7d;
 * this sweep expires stranded POST rows in the DB.
 *
 * Boundaries (load-bearing):
 *   - It NEVER touches a post that has a scheduled_posts row — once queued, a
 *     post is the scheduled-posts-worker's domain (dispatch failures, reclaim).
 *   - It NEVER touches a published post (published_at set / 'published' status).
 *   - It is idempotent: once expired, a post no longer matches the predicate,
 *     so a re-run is a clean no-op.
 *   - Every mutating statement re-checks the full predicate in its WHERE, so a
 *     post that gets scheduled/published between SELECT and UPDATE is skipped
 *     (no race-window expiry of content that just went live).
 *
 * Gated by ARIES_DRAFT_EXPIRY_ENABLED (default OFF). The worker
 * (scripts/automations/draft-expiry-sweep-worker.ts) is the standing process.
 */

import { withTaskExecutionLog } from '@/backend/telemetry/task-execution-log';

// ---------------------------------------------------------------------------
// Config / flag parsers (exported for tests)
// ---------------------------------------------------------------------------

export const DEFAULT_DRAFT_EXPIRY_AGE_DAYS = 14;
export const DEFAULT_DRAFT_EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const DEFAULT_DRAFT_EXPIRY_BATCH_SIZE = 200;
// Safety backstop on the commit loop. Each batch expires up to batchSize rows;
// 1000 batches × 200 = 200k rows per tick, far beyond any real backlog. A run
// that hits this cap is reported as truncated (loud) and resumes next tick.
export const DEFAULT_DRAFT_EXPIRY_MAX_BATCHES = 1000;

function parseFlag(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** True when ARIES_DRAFT_EXPIRY_ENABLED is set to a truthy value. Default OFF. */
export function draftExpiryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_DRAFT_EXPIRY_ENABLED);
}

/**
 * When ARIES_DRAFT_EXPIRY_DRY_RUN is truthy the sweep runs read-only (it counts
 * candidates and logs them but mutates nothing). Lets an operator flip
 * ENABLED=1 + DRY_RUN=1 for one observation cycle in prod before committing.
 * Default OFF (the sweep acts when ENABLED is on, matching the other workers).
 */
export function draftExpiryDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ARIES_DRAFT_EXPIRY_DRY_RUN);
}

function parsePositiveInt(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Tick interval (ms). Default 6h; non-positive/unparseable falls back. */
export function resolveDraftExpiryIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.ARIES_DRAFT_EXPIRY_INTERVAL_MS) ?? DEFAULT_DRAFT_EXPIRY_INTERVAL_MS;
}

/**
 * Age window (days) a post must sit untouched before it is eligible to expire.
 * Default 14. A generous window so a post the operator is actively reviewing is
 * never expired out from under them; nothing real is untouched for two weeks.
 */
export function resolveDraftExpiryAgeDays(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.ARIES_DRAFT_EXPIRY_AGE_DAYS) ?? DEFAULT_DRAFT_EXPIRY_AGE_DAYS;
}

// ---------------------------------------------------------------------------
// SQL (exported so the requires-infra test exercises the exact strings the
// worker runs, and the unit test asserts their shape)
// ---------------------------------------------------------------------------

/**
 * The stranded-draft predicate. Shared verbatim by the count, by-tenant,
 * select-batch, and expire-batch statements so they can never drift apart.
 * `$1` is ALWAYS the cutoff ISO timestamp (updated_at strictly before it).
 * `p` is the posts alias in every statement that embeds this.
 *
 * Keyed on the CANONICAL `published_status` column, NOT the legacy `status`
 * mirror. Most insert paths write only `published_status` and leave `status` at
 * its `'draft'` column default — e.g. a FB-native-scheduled post
 * (`persistScheduledPublishRecord`, backend/integrations/meta-publishing.ts)
 * has `published_status='scheduled'` but `status='draft'`, no `scheduled_posts`
 * row, and `published_at IS NULL`. OR-ing on the stale `status` default would
 * expire that live-on-Meta post. So selection trusts `published_status` only,
 * and `platform_post_id IS NULL` is a hard guard: a genuinely stranded draft
 * never reached Meta, so it has no platform post id. (The expire statement still
 * writes BOTH columns to 'expired' to keep them in lockstep.)
 */
export const STRANDED_PREDICATE = `
      NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.post_id = p.id)
      AND p.published_at IS NULL
      AND p.platform_post_id IS NULL
      AND p.published_status IN ('draft','in_review','approved')
      AND p.updated_at < $1`;

export const COUNT_SQL = `SELECT count(*)::bigint AS n
     FROM posts p
    WHERE ${STRANDED_PREDICATE}`;

export const COUNT_BY_TENANT_SQL = `SELECT p.tenant_id, count(*)::bigint AS n
     FROM posts p
    WHERE ${STRANDED_PREDICATE}
    GROUP BY p.tenant_id
    ORDER BY n DESC, p.tenant_id ASC`;

// $1 = cutoff, $2 = batch limit. Oldest-first so the most-stranded go first.
export const SELECT_BATCH_SQL = `SELECT p.id, p.tenant_id
     FROM posts p
    WHERE ${STRANDED_PREDICATE}
    ORDER BY p.updated_at ASC
    LIMIT $2`;

// $1 = cutoff, $2 = bigint[] of ids from the matching SELECT batch. The full
// predicate is re-checked in the WHERE so a row that got scheduled/published
// between the SELECT and this UPDATE is skipped (RETURNING reflects only the
// rows actually expired).
export const EXPIRE_BATCH_SQL = `UPDATE posts AS p
        SET published_status = 'expired',
            status           = 'expired',
            expired_at       = now(),
            updated_at       = now()
      WHERE p.id = ANY($2::bigint[])
        AND ${STRANDED_PREDICATE}
    RETURNING p.id, p.tenant_id`;

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type DraftExpirySweepOptions = {
  dryRun: boolean;
  ageDays: number;
  batchSize?: number;
  maxBatches?: number;
  now?: () => Date;
};

export type DraftExpirySweepReport = {
  cutoff: string;
  ageDays: number;
  dryRun: boolean;
  /** Total posts matching the predicate at scan time (before any mutation). */
  candidates: number;
  /** Rows actually expired this run (0 in dry-run). */
  expired: number;
  /** Number of commit batches executed. */
  batches: number;
  /** Per-tenant candidate counts at scan time (highest first). */
  byTenant: Array<{ tenantId: string; candidates: number }>;
  /** True if the commit loop hit maxBatches with work still remaining. */
  truncated: boolean;
  errors: number;
};

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * One sweep pass. Exported and dependency-injected (db, now) so a test can
 * drive it against a real client-in-a-transaction or a fake pool.
 *
 * dryRun=true issues ONLY the count queries — zero writes — so it is safe to run
 * against the production database for inspection.
 */
export async function runDraftExpirySweep(
  db: Queryable,
  opts: DraftExpirySweepOptions,
): Promise<DraftExpirySweepReport> {
  // AA-159: a sweep pass is DETERMINISTIC_RULE work — no model in the loop, so
  // zero tokens by construction. Logged on the caller's own db handle so the
  // telemetry row adds no extra pooled connection (guardrail #1). System-scoped:
  // the sweep spans every tenant, so the row carries no tenant_id.
  return withTaskExecutionLog(
    { engine: 'DETERMINISTIC_RULE', taskKey: 'marketing.draft_expiry_sweep' },
    () => runDraftExpirySweepPass(db, opts),
    { db },
  );
}

async function runDraftExpirySweepPass(
  db: Queryable,
  opts: DraftExpirySweepOptions,
): Promise<DraftExpirySweepReport> {
  const now = opts.now ?? (() => new Date());
  const ageDays = opts.ageDays > 0 ? opts.ageDays : DEFAULT_DRAFT_EXPIRY_AGE_DAYS;
  const batchSize =
    opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_DRAFT_EXPIRY_BATCH_SIZE;
  const maxBatches =
    opts.maxBatches && opts.maxBatches > 0 ? opts.maxBatches : DEFAULT_DRAFT_EXPIRY_MAX_BATCHES;
  const cutoff = new Date(now().getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();

  const report: DraftExpirySweepReport = {
    cutoff,
    ageDays,
    dryRun: opts.dryRun,
    candidates: 0,
    expired: 0,
    batches: 0,
    byTenant: [],
    truncated: false,
    errors: 0,
  };

  // Count + per-tenant breakdown for the report (cheap with the partial index).
  const countRes = await db.query(COUNT_SQL, [cutoff]);
  report.candidates = asNumber((countRes.rows[0] as { n?: unknown } | undefined)?.n);

  const byTenantRes = await db.query(COUNT_BY_TENANT_SQL, [cutoff]);
  report.byTenant = (byTenantRes.rows as Array<{ tenant_id: unknown; n: unknown }>).map((r) => ({
    tenantId: String(r.tenant_id),
    candidates: asNumber(r.n),
  }));

  if (opts.dryRun) {
    return report; // strictly read-only
  }

  // Commit loop. Each batch expires up to batchSize rows; expired rows drop out
  // of the predicate, so the next SELECT advances naturally (no OFFSET needed).
  let batches = 0;
  while (batches < maxBatches) {
    const sel = await db.query(SELECT_BATCH_SQL, [cutoff, batchSize]);
    const ids = (sel.rows as Array<{ id: unknown }>).map((r) => r.id).filter((id) => id != null);
    if (ids.length === 0) break;

    const upd = await db.query(EXPIRE_BATCH_SQL, [cutoff, ids]);
    report.expired += asNumber(upd.rowCount ?? (upd.rows ? upd.rows.length : 0));
    batches += 1;

    if (ids.length < batchSize) break; // last (partial) page
    if (batches >= maxBatches) {
      report.truncated = true; // hit the cap with a full last page — more may remain
      break;
    }
  }
  report.batches = batches;

  return report;
}
