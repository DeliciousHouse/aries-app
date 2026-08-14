type QueryResult = { rows: Array<Record<string, unknown>> };
export type MetricsDb = { query(text: string, params?: unknown[]): Promise<QueryResult> };

type CollectOptions = {
  hermesUp: boolean;
  draftExpiryAgeDays: number;
};

const MARKETING_SQL = `
  SELECT ms.tenant_id, ms.last_attempt_at, ms.last_success_at
    FROM marketing_schedule ms
    JOIN organizations o ON o.id = ms.tenant_id
   WHERE ms.enabled = true
     AND o.kind = 'production'
   ORDER BY ms.tenant_id`;

const QUEUE_SQL = `
  SELECT dispatch_status AS status, COUNT(*)::text AS count
    FROM scheduled_posts sp
    JOIN organizations o ON o.id = sp.tenant_id
   WHERE sp.dispatch_status IN ('pending', 'in_flight')
     AND o.kind = 'production'
   GROUP BY sp.dispatch_status
   ORDER BY sp.dispatch_status`;

const FAILED_SQL = `
  SELECT spd.status, COUNT(*)::text AS count
    FROM scheduled_post_dispatches spd
    JOIN scheduled_posts sp ON sp.id = spd.scheduled_post_id
    JOIN organizations o ON o.id = sp.tenant_id
   WHERE spd.status IN ('failed', 'dead_letter', 'manual_reconciliation')
     AND o.kind = 'production'
   GROUP BY spd.status
   ORDER BY spd.status`;

const PUBLISH_SQL = `
  SELECT sp.tenant_id, spd.platform, MAX(spd.dispatched_at) AS last_success_at
    FROM scheduled_post_dispatches spd
    JOIN scheduled_posts sp ON sp.id = spd.scheduled_post_id
    JOIN organizations o ON o.id = sp.tenant_id
   WHERE spd.status = 'dispatched'
     AND spd.dispatched_at IS NOT NULL
     AND o.kind = 'production'
   GROUP BY sp.tenant_id, spd.platform
   ORDER BY sp.tenant_id, spd.platform`;

const ACCOUNTS_SQL = `
  SELECT ca.tenant_id, ca.provider, ca.platform, ca.status, COUNT(*)::text AS count
    FROM connected_accounts ca
    JOIN organizations o ON o.id = ca.tenant_id
   WHERE o.kind = 'production'
   GROUP BY ca.tenant_id, ca.provider, ca.platform, ca.status
   ORDER BY ca.tenant_id, ca.provider, ca.platform, ca.status`;

const NUDGES_SQL = `
  WITH current_connections AS (
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
         SELECT 1 FROM connected_accounts ca
          WHERE ca.tenant_id = oc.tenant_id AND ca.platform = oc.provider
       )
  )
  SELECT c.tenant_id,
         c.platform,
         CASE WHEN c.status = 'reauthorization_required'
              THEN 'reauthorization_required'
              ELSE 'pending_over_7_days'
          END AS nudge_kind,
         MAX(n.sent_at) AS last_nudge_at
    FROM current_connections c
    JOIN organizations o ON o.id = c.tenant_id
    LEFT JOIN connection_nudge_notifications n
      ON n.source = c.source
     AND n.connection_id = c.connection_id
     AND n.status_changed_at = c.status_changed_at
     AND n.nudge_kind = CASE WHEN c.status = 'reauthorization_required'
                              THEN 'reauthorization_required'
                              ELSE 'pending_over_7_days'
                         END
   WHERE o.kind = 'production'
     AND (
       c.status = 'reauthorization_required'
       OR (c.status = 'pending' AND c.status_changed_at <= CURRENT_TIMESTAMP - INTERVAL '7 days')
     )
   GROUP BY c.tenant_id, c.platform, c.status
   ORDER BY c.tenant_id, c.platform`;

const EXPIRY_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE p.expired_at IS NOT NULL)::text AS expired_count,
    COUNT(*) FILTER (
      WHERE p.published_status IN ('draft', 'in_review', 'approved')
        AND p.published_at IS NULL
        AND p.platform_post_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.post_id = p.id)
        AND p.updated_at > CURRENT_TIMESTAMP - $1::int * INTERVAL '1 day'
        AND p.updated_at <= CURRENT_TIMESTAMP - $1::int * INTERVAL '1 day' + INTERVAL '24 hours'
    )::text AS expiring_24h_count
    FROM posts p
    JOIN organizations o ON o.id = p.tenant_id
   WHERE o.kind = 'production'`;

function label(value: unknown): string {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function seconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sample(name: string, labels: Record<string, unknown>, value: number): string {
  const rendered = Object.entries(labels)
    .map(([key, item]) => `${key}="${label(item)}"`)
    .join(',');
  return `${name}${rendered ? `{${rendered}}` : ''} ${value}`;
}

function family(lines: string[], name: string, help: string, type: 'gauge' | 'counter'): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
}

export async function collectAriesMetrics(db: MetricsDb, options: CollectOptions): Promise<string> {
  const marketing = await db.query(MARKETING_SQL);
  const queue = await db.query(QUEUE_SQL);
  const failed = await db.query(FAILED_SQL);
  const publishes = await db.query(PUBLISH_SQL);
  const accounts = await db.query(ACCOUNTS_SQL);
  const nudges = await db.query(NUDGES_SQL);
  const expiry = await db.query(EXPIRY_SQL, [options.draftExpiryAgeDays]);
  const lines: string[] = [];

  family(lines, 'aries_marketing_trigger_last_attempt_timestamp_seconds', 'Last weekly marketing trigger attempt.', 'gauge');
  for (const row of marketing.rows) {
    const value = seconds(row.last_attempt_at);
    if (value !== null) lines.push(sample('aries_marketing_trigger_last_attempt_timestamp_seconds', { tenant_id: row.tenant_id }, value));
  }
  family(lines, 'aries_marketing_trigger_last_success_timestamp_seconds', 'Last successful weekly marketing trigger submission.', 'gauge');
  for (const row of marketing.rows) {
    const value = seconds(row.last_success_at);
    if (value !== null) lines.push(sample('aries_marketing_trigger_last_success_timestamp_seconds', { tenant_id: row.tenant_id }, value));
  }

  family(lines, 'aries_dispatch_queue_depth', 'Current scheduled publish queue depth.', 'gauge');
  for (const row of queue.rows) lines.push(sample('aries_dispatch_queue_depth', { status: row.status }, number(row.count)));
  family(lines, 'aries_dispatch_failed_count', 'Current failed platform dispatches.', 'gauge');
  for (const row of failed.rows) lines.push(sample('aries_dispatch_failed_count', { status: row.status }, number(row.count)));

  family(lines, 'aries_last_successful_publish_timestamp_seconds', 'Last successful publish by tenant and platform.', 'gauge');
  for (const row of publishes.rows) {
    const value = seconds(row.last_success_at);
    if (value !== null) lines.push(sample('aries_last_successful_publish_timestamp_seconds', { tenant_id: row.tenant_id, platform: row.platform }, value));
  }

  family(lines, 'aries_connected_accounts', 'Connected account rows by provider, platform, and state.', 'gauge');
  const accountCounts = new Map<string, { provider: unknown; platform: unknown; status: unknown; count: number }>();
  for (const row of accounts.rows) {
    const key = JSON.stringify([row.provider, row.platform, row.status]);
    const current = accountCounts.get(key);
    if (current) current.count += number(row.count);
    else accountCounts.set(key, { provider: row.provider, platform: row.platform, status: row.status, count: number(row.count) });
  }
  for (const row of accountCounts.values()) lines.push(sample('aries_connected_accounts', { provider: row.provider, platform: row.platform, status: row.status }, row.count));

  family(lines, 'aries_connection_nudge_required', 'Whether a connection owner nudge is awaiting delivery.', 'gauge');
  family(lines, 'aries_connection_nudge_last_sent_timestamp_seconds', 'Last connection-health owner nudge delivery.', 'gauge');
  for (const row of nudges.rows) {
    const labels = { tenant_id: row.tenant_id, platform: row.platform, kind: row.nudge_kind };
    const lastSent = seconds(row.last_nudge_at);
    lines.push(sample('aries_connection_nudge_required', labels, lastSent === null ? 1 : 0));
    if (lastSent !== null) {
      lines.push(sample('aries_connection_nudge_last_sent_timestamp_seconds', labels, lastSent));
    }
  }

  const expiryRow = expiry.rows[0] ?? {};
  family(lines, 'aries_expiry_sweep_posts_total', 'Posts expired by the draft expiry sweep.', 'gauge');
  lines.push(sample('aries_expiry_sweep_posts_total', { result: 'expired' }, number(expiryRow.expired_count)));
  family(lines, 'aries_drafts_expiring_24h', 'Stranded drafts that become expiry candidates within 24 hours.', 'gauge');
  lines.push(sample('aries_drafts_expiring_24h', {}, number(expiryRow.expiring_24h_count)));

  family(lines, 'aries_external_dependency_up', 'Whether an external dependency is usable.', 'gauge');
  family(lines, 'aries_external_dependency_degraded', 'Whether an external dependency needs operator attention.', 'gauge');
  lines.push(sample('aries_external_dependency_up', { dependency: 'hermes' }, options.hermesUp ? 1 : 0));
  lines.push(sample('aries_external_dependency_degraded', { dependency: 'hermes' }, options.hermesUp ? 0 : 1));
  for (const row of accounts.rows) {
    const status = String(row.status);
    const labels = { tenant_id: row.tenant_id, platform: row.platform };
    const up = status === 'connected' ? 1 : 0;
    const degraded = ['pending', 'reauthorization_required', 'error'].includes(status) ? 1 : 0;
    lines.push(sample('aries_external_dependency_up', { dependency: 'platform_api', ...labels }, up));
    lines.push(sample('aries_external_dependency_degraded', { dependency: 'platform_api', ...labels }, degraded));
    if (row.provider === 'composio') {
      lines.push(sample('aries_external_dependency_up', { dependency: 'composio', ...labels }, up));
      lines.push(sample('aries_external_dependency_degraded', { dependency: 'composio', ...labels }, degraded));
    }
  }

  return `${lines.join('\n')}\n`;
}
