/**
 * scripts/insights-object-health.ts
 *
 * Read-only operator report for the insights object-health state
 * (backend/insights/sync/object-health.ts). Run it when a tenant's analytics
 * look thinner than they should:
 *
 *   npm run report:insights-health
 *   npm run report:insights-health -- 15        # one tenant
 *
 * WHY THIS EXISTS
 * ---------------
 * Quarantine deliberately stops a known-dead object from reporting its error on
 * every tick, which is what lets `insights_sync_runs.status` mean something
 * again. The cost is that genuinely missing data no longer shows up as a red
 * sync. This report — and the daily digest from the host monitor
 * (ops/aries-pipeline-monitor.py), which runs the same counts — is where that
 * cost is paid back. Do not treat quarantine as safe without one of them.
 *
 * Strictly SELECT-only. Safe against production.
 */

import pool from '@/lib/db';
import { QUARANTINE_STRIKES_PERMANENT, QUARANTINE_STRIKES_GENERIC, REPROBE_AFTER_DAYS } from '@/backend/insights/sync/object-health';

const tenantFilter = process.argv[2] ? Number(process.argv[2]) : null;
if (tenantFilter !== null && !Number.isFinite(tenantFilter)) {
  console.error('usage: tsx scripts/insights-object-health.ts [tenantId]');
  process.exit(2);
}

const where = tenantFilter === null ? '' : 'AND tenant_id = $1';
const params = tenantFilter === null ? [] : [tenantFilter];

async function main(): Promise<void> {
  console.log(
    `insights object health — quarantine after ${QUARANTINE_STRIKES_PERMANENT} permanent / ` +
    `${QUARANTINE_STRIKES_GENERIC} generic strikes; re-probed every ${REPROBE_AFTER_DAYS} days`,
  );

  const accounts = await pool.query(
    `SELECT tenant_id, platform, external_account_id, display_name,
            disabled_at, disabled_reason, last_sync_at
       FROM insights_accounts
      WHERE disabled_at IS NOT NULL ${where}
      ORDER BY tenant_id, platform`,
    params,
  );
  console.log(`\n── disabled accounts (${accounts.rowCount ?? 0}) ──`);
  if ((accounts.rowCount ?? 0) === 0) console.log('  none');
  for (const r of accounts.rows) {
    console.log(
      `  tenant ${r.tenant_id} ${String(r.platform).padEnd(10)} ${r.external_account_id} ` +
      `"${r.display_name ?? ''}" — ${r.disabled_reason} at ${r.disabled_at?.toISOString?.() ?? r.disabled_at}`,
    );
  }

  const quarantined = await pool.query(
    `SELECT tenant_id, account_id, platform,
            count(*) FILTER (WHERE metrics_unavailable_at IS NOT NULL)  AS metrics_quarantined,
            count(*) FILTER (WHERE comments_unavailable_at IS NOT NULL) AS comments_quarantined
       FROM insights_posts
      WHERE (metrics_unavailable_at IS NOT NULL OR comments_unavailable_at IS NOT NULL) ${where}
      GROUP BY 1, 2, 3
      ORDER BY 1, 3`,
    params,
  );
  console.log(`\n── quarantined objects by account (${quarantined.rowCount ?? 0} accounts) ──`);
  if ((quarantined.rowCount ?? 0) === 0) console.log('  none');
  for (const r of quarantined.rows) {
    console.log(
      `  tenant ${r.tenant_id} account ${r.account_id} ${String(r.platform).padEnd(10)} ` +
      `metrics=${r.metrics_quarantined} comments=${r.comments_quarantined}`,
    );
  }

  const errors = await pool.query(
    `SELECT err, count(*) AS n FROM (
       SELECT left(metrics_last_error, 160) AS err FROM insights_posts
        WHERE metrics_last_error IS NOT NULL ${where}
       UNION ALL
       SELECT left(comments_last_error, 160) AS err FROM insights_posts
        WHERE comments_last_error IS NOT NULL ${where}
     ) t
     GROUP BY err ORDER BY n DESC LIMIT 5`,
    params,
  );
  console.log('\n── top failure messages ──');
  if ((errors.rowCount ?? 0) === 0) console.log('  none');
  for (const r of errors.rows) console.log(`  ${String(r.n).padStart(5)}  ${r.err}`);

  // Objects accumulating strikes but not yet quarantined: the leading
  // indicator. A growing count here means something is going wrong NOW, before
  // quarantine makes it quiet.
  const striking = await pool.query(
    `SELECT tenant_id, platform,
            count(*) FILTER (WHERE metrics_error_count  > 0 AND metrics_unavailable_at  IS NULL) AS metrics_striking,
            count(*) FILTER (WHERE comments_error_count > 0 AND comments_unavailable_at IS NULL) AS comments_striking
       FROM insights_posts
      WHERE (metrics_error_count > 0 OR comments_error_count > 0) ${where}
      GROUP BY 1, 2
      HAVING count(*) FILTER (WHERE metrics_error_count  > 0 AND metrics_unavailable_at  IS NULL) > 0
          OR count(*) FILTER (WHERE comments_error_count > 0 AND comments_unavailable_at IS NULL) > 0
      ORDER BY 1, 2`,
    params,
  );
  console.log(`\n── striking but not yet quarantined (${striking.rowCount ?? 0}) ──`);
  if ((striking.rowCount ?? 0) === 0) console.log('  none');
  for (const r of striking.rows) {
    console.log(`  tenant ${r.tenant_id} ${String(r.platform).padEnd(10)} metrics=${r.metrics_striking} comments=${r.comments_striking}`);
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
