import { sendConnectionHealthNudgeEmail } from '@/lib/email';

export type ConnectionNudgeKind = 'reauthorization_required' | 'pending_over_7_days';

export interface ConnectionHealthNudgeEmail {
  to: string;
  workspaceName: string;
  platform: string;
  kind: ConnectionNudgeKind;
  reconnectUrl: string;
}

export interface ConnectionHealthNudgeDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export const SELECT_CONNECTION_NUDGE_CANDIDATES_SQL = `
  WITH connection_candidates AS (
    SELECT 'connected_accounts'::text AS source,
           ca.id AS connection_id,
           ca.tenant_id,
           ca.platform,
           ca.status,
           ca.status_changed_at
      FROM connected_accounts ca
     WHERE ca.status IN ('pending', 'reauthorization_required')
    UNION ALL
    SELECT 'oauth_connections'::text AS source,
           oc.id AS connection_id,
           oc.tenant_id,
           oc.provider AS platform,
           oc.status,
           oc.status_changed_at
      FROM oauth_connections oc
     WHERE oc.status IN ('pending', 'reauthorization_required')
       AND oc.provider <> 'slack'
       AND NOT EXISTS (
         SELECT 1
           FROM connected_accounts ca
          WHERE ca.tenant_id = oc.tenant_id
            AND ca.platform = oc.provider
       )
  )
  SELECT c.source,
         c.connection_id::text,
         c.tenant_id,
         o.name AS organization_name,
         c.platform,
         c.status,
         c.status_changed_at,
         CASE
           WHEN c.status = 'reauthorization_required' THEN 'reauthorization_required'
           ELSE 'pending_over_7_days'
         END AS nudge_kind
    FROM connection_candidates c
    JOIN organizations o ON o.id = c.tenant_id
   WHERE o.kind = 'production'
     AND (
       c.status = 'reauthorization_required'
       OR (c.status = 'pending' AND c.status_changed_at <= $1::timestamptz - INTERVAL '7 days')
     )
   ORDER BY c.tenant_id, c.platform, c.source`;

export const SELECT_CONNECTION_NUDGE_RECIPIENTS_SQL = `
  SELECT u.email
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = $1
     AND m.status = 'active'
     AND m.role = 'tenant_admin'
     AND u.email IS NOT NULL`;

export const CLAIM_CONNECTION_NUDGE_SQL = `
  INSERT INTO connection_nudge_notifications
    (source, connection_id, tenant_id, platform, nudge_kind, status_changed_at, sent_at)
  VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
  ON CONFLICT (source, connection_id, nudge_kind, status_changed_at) DO NOTHING`;

export function connectionNudgesEnabled(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.ARIES_CONNECTION_NUDGES_ENABLED?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

interface CandidateRow extends Record<string, unknown> {
  source: 'connected_accounts' | 'oauth_connections';
  connection_id: string;
  tenant_id: number;
  organization_name: string;
  platform: string;
  status: 'pending' | 'reauthorization_required';
  status_changed_at: Date | string;
  nudge_kind: ConnectionNudgeKind;
}

export interface ConnectionHealthNudgeReport {
  skipped: boolean;
  candidates: number;
  claimed: number;
  deduped: number;
  emailsSent: number;
  noRecipient: number;
  errors: number;
}

type Options = {
  env?: Partial<Record<string, string | undefined>>;
  now?: () => Date;
  appBaseUrl?: string;
  send?: (email: ConnectionHealthNudgeEmail) => Promise<void>;
};

export async function runConnectionHealthNudges(
  db: ConnectionHealthNudgeDb,
  options: Options = {},
): Promise<ConnectionHealthNudgeReport> {
  const env = options.env ?? process.env;
  const report: ConnectionHealthNudgeReport = {
    skipped: true,
    candidates: 0,
    claimed: 0,
    deduped: 0,
    emailsSent: 0,
    noRecipient: 0,
    errors: 0,
  };
  if (!connectionNudgesEnabled(env)) return report;

  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const baseUrl = (options.appBaseUrl ?? env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  const reconnectUrl = `${baseUrl}/dashboard/settings/channel-integrations`;
  const send = options.send ?? sendConnectionHealthNudgeEmail;
  const candidates = await db.query(SELECT_CONNECTION_NUDGE_CANDIDATES_SQL, [nowIso]);
  const candidateRows = candidates.rows as CandidateRow[];
  report.skipped = false;
  report.candidates = candidateRows.length;

  for (const candidate of candidateRows) {
    try {
      const recipients = await db.query(SELECT_CONNECTION_NUDGE_RECIPIENTS_SQL, [
        Number(candidate.tenant_id),
      ]);
      const emails = recipients.rows
        .map((row) => String(row.email ?? '').trim())
        .filter(Boolean);
      if (emails.length === 0) {
        report.noRecipient += 1;
        continue;
      }

      const stateChangedAt =
        candidate.status_changed_at instanceof Date
          ? candidate.status_changed_at.toISOString()
          : new Date(String(candidate.status_changed_at)).toISOString();
      const claimParams = [
        candidate.source,
        candidate.connection_id,
        Number(candidate.tenant_id),
        candidate.platform,
        candidate.nudge_kind,
        stateChangedAt,
        nowIso,
      ];
      const claim = await db.query(CLAIM_CONNECTION_NUDGE_SQL, claimParams);
      if ((claim.rowCount ?? claim.rows.length) === 0) {
        report.deduped += 1;
        continue;
      }
      report.claimed += 1;

      for (const to of emails) {
        await send({
          to,
          workspaceName: candidate.organization_name,
          platform: candidate.platform,
          kind: candidate.nudge_kind,
          reconnectUrl,
        });
        report.emailsSent += 1;
      }
    } catch (error) {
      report.errors += 1;
      console.error('[connection-health-nudges] candidate failed', {
        tenantId: candidate.tenant_id,
        platform: candidate.platform,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
