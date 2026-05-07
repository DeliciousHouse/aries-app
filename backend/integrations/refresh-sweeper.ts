import pool from '@/lib/db';
import { sendMetaReconnectWarningEmail } from '@/lib/email';

import type { OAuthBrokerError } from './connect';
import { dbAuditEvent, type DbProvider } from './oauth-db';
import { oauthRefresh, type OAuthRefreshSuccess } from './refresh';

export type SweeperQueryResult = { rows: unknown[]; rowCount: number | null };

export type SweeperQueryable = {
  query(sql: string, params?: unknown[]): Promise<SweeperQueryResult>;
};

const DEFAULT_REFRESH_HORIZON_HOURS = 24;
// Meta long-lived tokens live ~60 days; 10-day window matches the "day 50" warning contract.
const DEFAULT_WARNING_WINDOW_DAYS = 10;
const DEFAULT_WARNING_COOLDOWN_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type SweeperRefreshCandidate = {
  connectionId: string;
  tenantId: string;
  provider: DbProvider;
  tokenExpiresAt: string;
  refreshExpiresAt: string | null;
};

export type SweeperWarningCandidate = {
  connectionId: string;
  tenantId: string;
  provider: DbProvider;
  tokenExpiresAt: string;
  operatorEmail: string | null;
  daysUntilExpiry: number;
};

export type SweeperRefreshOutcome =
  | { kind: 'refreshed'; tokenExpiresAt: string | null }
  | { kind: 'skipped_unchanged' }
  | { kind: 'reauth_required'; errorMessage: string }
  | { kind: 'unknown_failure'; errorMessage: string };

export type SweeperWarningOutcome =
  | { kind: 'sent'; daysUntilExpiry: number }
  | { kind: 'skipped_already_warned' }
  | { kind: 'skipped_no_email' }
  | { kind: 'skipped_dry_run' }
  | { kind: 'failed'; errorMessage: string };

export type SweeperRefreshResult = {
  candidate: SweeperRefreshCandidate;
  outcome: SweeperRefreshOutcome;
};

export type SweeperWarningResult = {
  candidate: SweeperWarningCandidate;
  outcome: SweeperWarningOutcome;
};

export type SweeperReport = {
  dryRun: boolean;
  scannedAt: string;
  refreshHorizonHours: number;
  warningWindowDays: number;
  warningCooldownHours: number;
  refreshCandidates: SweeperRefreshCandidate[];
  warningCandidates: SweeperWarningCandidate[];
  refreshResults: SweeperRefreshResult[];
  warningResults: SweeperWarningResult[];
  errors: number;
};

export type SweeperRefreshFn = (
  provider: DbProvider,
  tenantId: string,
) => Promise<OAuthRefreshSuccess | OAuthBrokerError>;

export type SweeperEmailFn = (params: {
  to: string;
  daysUntilExpiry: number;
  reconnectUrl: string;
}) => Promise<void>;

export type SweeperAuditFn = (args: {
  tenantId?: string | null;
  connectionId?: string | null;
  provider?: string | null;
  eventType: string;
  eventStatus: 'ok' | 'error';
  detail?: unknown;
}) => Promise<void>;

export type SweeperOptions = {
  dryRun: boolean;
  appBaseUrl?: string | null;
  refreshHorizonHours?: number;
  warningWindowDays?: number;
  warningCooldownHours?: number;
  now?: () => Date;
  client?: SweeperQueryable;
  refresh?: SweeperRefreshFn;
  sendWarning?: SweeperEmailFn;
  audit?: SweeperAuditFn;
};

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function reconnectUrlFor(appBaseUrl: string | null): string {
  if (!appBaseUrl) {
    return '/platforms';
  }
  return `${trimSlash(appBaseUrl)}/platforms`;
}

function diffDays(later: Date, earlier: Date): number {
  const ms = later.getTime() - earlier.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / MS_PER_DAY));
}

export async function listRefreshCandidates(
  client: SweeperQueryable,
  horizon: Date,
): Promise<SweeperRefreshCandidate[]> {
  const result = await client.query(
    `
      SELECT
        id::text AS connection_id,
        tenant_id::text AS tenant_id,
        provider,
        token_expires_at,
        refresh_expires_at
      FROM oauth_connections
      WHERE status = 'connected'
        AND token_expires_at IS NOT NULL
        AND token_expires_at < $1::timestamptz
      ORDER BY token_expires_at ASC
    `,
    [horizon.toISOString()],
  );
  const rows = (result.rows ?? []) as Array<{
    connection_id: string;
    tenant_id: string;
    provider: string;
    token_expires_at: string;
    refresh_expires_at: string | null;
  }>;
  return rows.map((row) => ({
    connectionId: String(row.connection_id),
    tenantId: String(row.tenant_id),
    provider: row.provider as DbProvider,
    tokenExpiresAt: String(row.token_expires_at),
    refreshExpiresAt: row.refresh_expires_at ? String(row.refresh_expires_at) : null,
  }));
}

export async function listWarningCandidates(
  client: SweeperQueryable,
  now: Date,
  warningHorizon: Date,
): Promise<SweeperWarningCandidate[]> {
  const result = await client.query(
    `
      SELECT
        oc.id::text AS connection_id,
        oc.tenant_id::text AS tenant_id,
        oc.provider,
        oc.token_expires_at,
        u.email AS operator_email
      FROM oauth_connections oc
      LEFT JOIN LATERAL (
        SELECT email
        FROM users
        WHERE organization_id = oc.tenant_id
        ORDER BY
          CASE WHEN role = 'tenant_admin' THEN 0 ELSE 1 END,
          id ASC
        LIMIT 1
      ) u ON true
      WHERE oc.status = 'connected'
        AND oc.provider IN ('facebook','instagram')
        AND oc.token_expires_at IS NOT NULL
        AND oc.token_expires_at > $1::timestamptz
        AND oc.token_expires_at < $2::timestamptz
      ORDER BY oc.token_expires_at ASC
    `,
    [now.toISOString(), warningHorizon.toISOString()],
  );
  const rows = (result.rows ?? []) as Array<{
    connection_id: string;
    tenant_id: string;
    provider: string;
    token_expires_at: string;
    operator_email: string | null;
  }>;
  return rows.map((row) => {
    const tokenExpiresAt = String(row.token_expires_at);
    const days = diffDays(new Date(tokenExpiresAt), now);
    return {
      connectionId: String(row.connection_id),
      tenantId: String(row.tenant_id),
      provider: row.provider as DbProvider,
      tokenExpiresAt,
      operatorEmail: row.operator_email ?? null,
      daysUntilExpiry: days,
    };
  });
}

async function tenantHasRecentWarning(
  client: SweeperQueryable,
  tenantId: string,
  cooldownStart: Date,
): Promise<boolean> {
  const tenantIdInt = Number.parseInt(tenantId, 10);
  if (!Number.isFinite(tenantIdInt)) return false;
  const result = await client.query(
    `
      SELECT 1 AS hit
      FROM oauth_audit_events
      WHERE tenant_id = $1
        AND event_type = 'oauth.reconnect_warning.sent'
        AND occurred_at > $2::timestamptz
      LIMIT 1
    `,
    [tenantIdInt, cooldownStart.toISOString()],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function runOAuthRefreshSweep(options: SweeperOptions): Promise<SweeperReport> {
  const { dryRun } = options;
  const refreshHorizonHours = options.refreshHorizonHours ?? DEFAULT_REFRESH_HORIZON_HOURS;
  const warningWindowDays = options.warningWindowDays ?? DEFAULT_WARNING_WINDOW_DAYS;
  const warningCooldownHours = options.warningCooldownHours ?? DEFAULT_WARNING_COOLDOWN_HOURS;
  const nowFn = options.now ?? (() => new Date());
  const client: SweeperQueryable = options.client ?? pool;
  const refreshFn: SweeperRefreshFn = options.refresh ?? oauthRefresh;
  const emailFn: SweeperEmailFn =
    options.sendWarning ?? ((params) => sendMetaReconnectWarningEmail(params));
  const auditFn: SweeperAuditFn = options.audit ?? dbAuditEvent;
  const appBaseUrl = (options.appBaseUrl ?? process.env.APP_BASE_URL ?? '').trim() || null;

  const now = nowFn();
  const refreshHorizon = new Date(now.getTime() + refreshHorizonHours * MS_PER_HOUR);
  const warningHorizon = new Date(now.getTime() + warningWindowDays * MS_PER_DAY);
  const cooldownStart = new Date(now.getTime() - warningCooldownHours * MS_PER_HOUR);

  const refreshCandidates = await listRefreshCandidates(client, refreshHorizon);
  const warningCandidates = await listWarningCandidates(client, now, warningHorizon);

  const refreshResults: SweeperRefreshResult[] = [];
  const warningResults: SweeperWarningResult[] = [];
  let errors = 0;

  if (!dryRun) {
    for (const candidate of refreshCandidates) {
      try {
        const result = await refreshFn(candidate.provider, candidate.tenantId);
        if (result.broker_status === 'ok') {
          const outcome: SweeperRefreshOutcome = result.refreshed
            ? { kind: 'refreshed', tokenExpiresAt: result.token_expires_at }
            : { kind: 'skipped_unchanged' };
          refreshResults.push({ candidate, outcome });
          await auditFn({
            tenantId: candidate.tenantId,
            connectionId: candidate.connectionId,
            provider: candidate.provider,
            eventType: 'oauth.refresh_sweep.refreshed',
            eventStatus: 'ok',
            detail: {
              token_expires_at: result.token_expires_at,
              refreshed: result.refreshed,
            },
          });
        } else {
          // oauthRefresh already flips status to reauthorization_required on 401/403; the sweeper just records its observation.
          const errorMessage = result.message ?? result.reason;
          const isReauthLikely =
            result.reason === 'provider_callback_error' ||
            result.reason === 'connection_not_found';
          const outcome: SweeperRefreshOutcome = isReauthLikely
            ? { kind: 'reauth_required', errorMessage }
            : { kind: 'unknown_failure', errorMessage };
          refreshResults.push({ candidate, outcome });
          await auditFn({
            tenantId: candidate.tenantId,
            connectionId: candidate.connectionId,
            provider: candidate.provider,
            eventType: 'oauth.refresh_sweep.failed',
            eventStatus: 'error',
            detail: {
              reason: result.reason,
              message: errorMessage,
            },
          });
          errors += 1;
        }
      } catch (err) {
        errors += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        refreshResults.push({
          candidate,
          outcome: { kind: 'unknown_failure', errorMessage },
        });
        try {
          await auditFn({
            tenantId: candidate.tenantId,
            connectionId: candidate.connectionId,
            provider: candidate.provider,
            eventType: 'oauth.refresh_sweep.failed',
            eventStatus: 'error',
            detail: { reason: 'sweeper_exception', message: errorMessage },
          });
        } catch (auditErr) {
          console.error('[oauth-refresh-sweep] audit write failed', auditErr);
        }
      }
    }
  }

  // Per-tenant dedup: Meta and Instagram share one operator inbox, so one warning per tenant covers both.
  const warnedTenantsThisRun = new Set<string>();
  for (const candidate of warningCandidates) {
    if (dryRun) {
      warningResults.push({ candidate, outcome: { kind: 'skipped_dry_run' } });
      continue;
    }
    if (warnedTenantsThisRun.has(candidate.tenantId)) {
      warningResults.push({ candidate, outcome: { kind: 'skipped_already_warned' } });
      continue;
    }
    if (!candidate.operatorEmail) {
      warningResults.push({ candidate, outcome: { kind: 'skipped_no_email' } });
      continue;
    }
    const recentlyWarned = await tenantHasRecentWarning(client, candidate.tenantId, cooldownStart);
    if (recentlyWarned) {
      warningResults.push({ candidate, outcome: { kind: 'skipped_already_warned' } });
      continue;
    }
    try {
      await emailFn({
        to: candidate.operatorEmail,
        daysUntilExpiry: candidate.daysUntilExpiry,
        reconnectUrl: reconnectUrlFor(appBaseUrl),
      });
      await auditFn({
        tenantId: candidate.tenantId,
        connectionId: candidate.connectionId,
        provider: candidate.provider,
        eventType: 'oauth.reconnect_warning.sent',
        eventStatus: 'ok',
        detail: {
          email: candidate.operatorEmail,
          days_until_expiry: candidate.daysUntilExpiry,
          token_expires_at: candidate.tokenExpiresAt,
        },
      });
      warnedTenantsThisRun.add(candidate.tenantId);
      warningResults.push({
        candidate,
        outcome: { kind: 'sent', daysUntilExpiry: candidate.daysUntilExpiry },
      });
    } catch (err) {
      errors += 1;
      const errorMessage = err instanceof Error ? err.message : String(err);
      warningResults.push({ candidate, outcome: { kind: 'failed', errorMessage } });
      try {
        await auditFn({
          tenantId: candidate.tenantId,
          connectionId: candidate.connectionId,
          provider: candidate.provider,
          eventType: 'oauth.reconnect_warning.failed',
          eventStatus: 'error',
          detail: { message: errorMessage },
        });
      } catch (auditErr) {
        console.error('[oauth-refresh-sweep] audit write failed', auditErr);
      }
    }
  }

  return {
    dryRun,
    scannedAt: now.toISOString(),
    refreshHorizonHours,
    warningWindowDays,
    warningCooldownHours,
    refreshCandidates,
    warningCandidates,
    refreshResults,
    warningResults,
    errors,
  };
}
