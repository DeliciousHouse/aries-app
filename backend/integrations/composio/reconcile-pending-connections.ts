/**
 * Sweeps `connected_accounts` rows with status='pending' and calls
 * refreshConnectionStatus for each one so that a Composio-side ACTIVE
 * connection (which can take several minutes to activate) is reflected in
 * the local DB without requiring operator intervention.
 *
 * Design:
 *   - Scoped to rows updated_at within the last GRACE_MINUTES (default 30) to
 *     avoid touching very old pending rows that Composio has already expired.
 *   - Per-row failures are isolated: a single Composio API error does not abort
 *     the sweep for other tenants.
 *   - Fail-safe: any top-level failure is caught and logged; the function never
 *     throws so the worker loop never crashes.
 *   - deps is injectable for unit tests (no live DB / Composio API required).
 */

import pool from '@/lib/db';
import { getAccountConnectionProvider } from '@/backend/integrations/providers/provider-factory';
import type { AccountConnectionProvider } from '@/backend/integrations/providers/interfaces';
import type { IntegrationPlatform } from '@/backend/integrations/providers/types';

export const DEFAULT_RECONCILE_GRACE_MINUTES = 30;

export interface ReconcileSummary {
  scanned: number;
  reconciled: number;
  stillPending: number;
  errors: number;
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

export interface ReconcileDeps {
  /** Injectable queryable (pool default). */
  db?: Queryable;
  /** Injectable account-connection provider (real default). */
  provider?: AccountConnectionProvider | null;
  /** Grace window in minutes — only rows updated within this window are swept. */
  graceMinutes?: number;
}

export async function reconcilePendingConnections(deps?: ReconcileDeps): Promise<ReconcileSummary> {
  const zero: ReconcileSummary = { scanned: 0, reconciled: 0, stillPending: 0, errors: 0 };
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
    const summary: ReconcileSummary = { scanned: rows.length, reconciled: 0, stillPending: 0, errors: 0 };

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

    return summary;
  } catch (err) {
    console.error('[reconcile-pending-connections] top-level sweep error', err);
    return { scanned: 0, reconciled: 0, stillPending: 0, errors: 1 };
  }
}
