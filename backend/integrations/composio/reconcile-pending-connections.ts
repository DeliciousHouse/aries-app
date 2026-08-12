/**
 * Keeps `connected_accounts` agreeing with Composio, in BOTH directions.
 *
 * PROMOTION (original behaviour): rows with status='pending' are refreshed so a
 * Composio-side ACTIVE connection (which can take several minutes to activate)
 * lands in the local DB without operator intervention.
 *
 * DEMOTION (added 2026-08-12): rows we already believe are live are re-checked
 * on a slower cadence, so a connection that DIES stops being advertised as
 * healthy.
 *
 * Why demotion had to be added: the pending-only sweep made `connected` a
 * terminal state. Nothing else writes this table after the connect flow, so a
 * connection that expired later kept reporting `connected` forever — the UI
 * showed a green channel, the publish-eligibility gate let a whole week of
 * content be generated against it, and the posts dead-lettered days later with
 * no warning. Tenant 15's X connection sat `connected` for ~28 days after
 * Composio recorded "Permanent auth error during token refresh".
 *
 * The demotion itself needed no new logic: refreshConnectionStatus already
 * persists mapComposioStatus(live status), and EXPIRED/REVOKED already map to
 * `reauthorization_required`. The only thing missing was ever calling it on a
 * non-pending row.
 *
 * Design:
 *   - Promotion stays scoped to rows updated within GRACE_MINUTES (default 30)
 *     so very old pending rows are not churned.
 *   - Demotion re-checks rows not seen for RECHECK_HOURS (default 6), capped at
 *     RECHECK_LIMIT rows per sweep, oldest first — a slow rolling audit rather
 *     than a full-table scan every minute.
 *   - FAIL-SAFE, and this is the property that matters: an unreachable Composio
 *     makes refreshConnectionStatus THROW, which this sweep counts as an error
 *     and moves on. A live channel is never demoted because of a transient API
 *     failure; only a definitive non-ACTIVE status demotes.
 *   - Per-row failures are isolated: one bad tenant does not abort the sweep.
 *   - Any top-level failure is caught and logged; the function never throws so
 *     the worker loop never crashes.
 *   - deps is injectable for unit tests (no live DB / Composio API required).
 */

import pool from '@/lib/db';
import { getAccountConnectionProvider } from '@/backend/integrations/providers/provider-factory';
import type { AccountConnectionProvider } from '@/backend/integrations/providers/interfaces';
import type { IntegrationPlatform } from '@/backend/integrations/providers/types';

export const DEFAULT_RECONCILE_GRACE_MINUTES = 30;
/** How stale a believed-live row may get before it is re-verified. */
export const DEFAULT_RECHECK_HOURS = 6;
/** Max believed-live rows re-verified per sweep (oldest first). */
export const DEFAULT_RECHECK_LIMIT = 25;

/**
 * Statuses we advertise to the tenant as usable. These are the rows that can
 * silently go stale, so these are the rows the demotion pass re-verifies.
 * `reauthorization_required` is included deliberately: if a tenant repairs a
 * connection outside our connect flow it should be able to heal back to
 * `connected` without a support ticket.
 */
const RECHECKABLE_STATUSES = ['connected', 'reauthorization_required'] as const;

export interface ReconcileSummary {
  scanned: number;
  reconciled: number;
  stillPending: number;
  errors: number;
  /** Believed-live rows re-verified this sweep. */
  rechecked: number;
  /** Rows that were advertised as usable and turned out not to be. */
  demoted: number;
}

/** A queryable DB pool — injectable for tests. */
export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface PendingRow {
  tenant_id: number;
  platform: string;
  external_user_id: string;
}

interface RecheckRow extends PendingRow {
  status: string;
}

export interface ReconcileDeps {
  /** Injectable queryable (pool default). */
  db?: Queryable;
  /** Injectable account-connection provider (real default). */
  provider?: AccountConnectionProvider | null;
  /** Grace window in minutes — only rows updated within this window are swept. */
  graceMinutes?: number;
  /** Re-verify believed-live rows not seen for this many hours. */
  recheckHours?: number;
  /** Cap on believed-live rows re-verified per sweep. */
  recheckLimit?: number;
}

export async function reconcilePendingConnections(deps?: ReconcileDeps): Promise<ReconcileSummary> {
  const zero: ReconcileSummary = {
    scanned: 0, reconciled: 0, stillPending: 0, errors: 0, rechecked: 0, demoted: 0,
  };
  try {
    const graceMinutes =
      deps?.graceMinutes != null && deps.graceMinutes > 0
        ? deps.graceMinutes
        : DEFAULT_RECONCILE_GRACE_MINUTES;
    const db = deps?.db ?? pool;
    // Provider defaults to the real Composio account provider (null when
    // Composio is disabled — in that case there is nothing to reconcile).
    const provider =
      Object.prototype.hasOwnProperty.call(deps ?? {}, 'provider')
        ? (deps!.provider ?? null)
        : getAccountConnectionProvider();

    if (!provider) {
      // Composio disabled — nothing to do.
      return zero;
    }

    const result = await db.query<PendingRow>(
      `SELECT tenant_id, platform, external_user_id
         FROM connected_accounts
        WHERE status = 'pending'
          AND updated_at > now() - ($1::int * interval '1 minute')`,
      [graceMinutes],
    );

    const rows = result.rows;
    const summary: ReconcileSummary = {
      scanned: rows.length, reconciled: 0, stillPending: 0, errors: 0, rechecked: 0, demoted: 0,
    };

    for (const row of rows) {
      try {
        const refreshed = await provider.refreshConnectionStatus(
          row.external_user_id,
          row.platform as IntegrationPlatform,
          { tenantId: String(row.tenant_id) },
        );
        if (refreshed?.status === 'connected') {
          summary.reconciled += 1;
        } else {
          summary.stillPending += 1;
        }
      } catch (err) {
        summary.errors += 1;
        console.warn(
          `[reconcile-pending-connections] error for tenant=${row.tenant_id} platform=${row.platform}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ---- DEMOTION PASS -----------------------------------------------------
    // Re-verify rows we currently advertise as usable. Without this, `connected`
    // is a terminal state: nothing else writes this table after connect, so a
    // channel that dies keeps showing green until someone notices a failed
    // publish days later.
    //
    // Oldest-first with a per-sweep cap makes this a slow rolling audit: every
    // row gets re-verified eventually without hammering Composio each minute.
    const recheckHours =
      deps?.recheckHours != null && deps.recheckHours > 0 ? deps.recheckHours : DEFAULT_RECHECK_HOURS;
    const recheckLimit =
      deps?.recheckLimit != null && deps.recheckLimit > 0 ? deps.recheckLimit : DEFAULT_RECHECK_LIMIT;

    const staleResult = await db.query<RecheckRow>(
      `SELECT tenant_id, platform, external_user_id, status
         FROM connected_accounts
        WHERE status = ANY($1::text[])
          AND updated_at < now() - ($2::int * interval '1 hour')
        ORDER BY updated_at ASC
        LIMIT $3::int`,
      [[...RECHECKABLE_STATUSES], recheckHours, recheckLimit],
    );

    summary.rechecked = staleResult.rows.length;

    for (const row of staleResult.rows) {
      const was = row.status;
      try {
        const refreshed = await provider.refreshConnectionStatus(
          row.external_user_id,
          row.platform as IntegrationPlatform,
          { tenantId: String(row.tenant_id) },
        );
        const now = refreshed?.status ?? null;
        if (was === 'connected' && now !== 'connected') {
          // The case this pass exists for. Log loudly: a tenant just lost a
          // channel and every downstream gate (publish eligibility, the UI)
          // reads this row.
          summary.demoted += 1;
          console.warn(
            `[reconcile-pending-connections] DEMOTED tenant=${row.tenant_id} platform=${row.platform} ` +
              `connected -> ${now ?? 'unknown'} (channel is no longer publishable; tenant must reconnect)`,
          );
        } else if (was !== 'connected' && now === 'connected') {
          console.info(
            `[reconcile-pending-connections] healed tenant=${row.tenant_id} platform=${row.platform} ` +
              `${was} -> connected`,
          );
        }
      } catch (err) {
        // FAIL-SAFE. refreshConnectionStatus throws when Composio is
        // unreachable, and an unreachable broker is NOT evidence a channel is
        // dead. Count it and leave the row exactly as it was — demoting a
        // working channel on a transient 5xx would turn a display bug into an
        // outage.
        summary.errors += 1;
        console.warn(
          `[reconcile-pending-connections] recheck error (row left unchanged) ` +
            `tenant=${row.tenant_id} platform=${row.platform}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return summary;
  } catch (err) {
    console.error('[reconcile-pending-connections] top-level sweep error', err);
    return { scanned: 0, reconciled: 0, stillPending: 0, errors: 1, rechecked: 0, demoted: 0 };
  }
}
