/**
 * AA-164 — 80% / 95% quota-exhaustion alerts.
 *
 * Runs on the existing hourly usage-rollup tick rather than as a ninth sidecar:
 * that loop already recomputes exactly the numbers an alert needs, so a separate
 * process would be a second schedule to operate for no extra freshness.
 *
 * Three properties this has to get right:
 *
 *   1. NO SPAM. The sweep runs hourly, so a company sitting at 96% would
 *      otherwise be emailed every hour until the month turned over. The
 *      (company, period, threshold) primary key on usage_alert_notifications IS
 *      the dedupe, and the row is CLAIMED BEFORE the send — a crash mid-send
 *      costs one alert, whereas claiming after would re-send on every tick until
 *      one succeeded.
 *   2. NO FALSE ALARMS. Unmetered or unlimited companies are skipped entirely;
 *      an alert derived from an empty rollup would be noise about nothing.
 *   3. NO FAN-OUT. One query gathers every company's allowance, consumption and
 *      credits; the per-company work is then sequential (guardrail #1).
 *
 * Alerts are bounded by the rollup lag (up to one tick), so a 95% alert can
 * arrive when a company is already past 100%. The email states the real
 * percentage rather than the threshold for that reason.
 */

import { sendQuotaThresholdEmail } from '@/lib/email';
import {
  resolveFleetTenantKinds,
  type OrganizationKind,
} from '@/backend/tenant/organization-kind';

import { computeQuotaFigures } from './quota-summary';
import { DEFAULT_PLAN_TIER, isPlanTier, resolveIncludedAllowance, type PlanTier } from './rate-cards';
import { resolvePlanEnforcementMetric, type PlanEnforcementMetric } from './plan-enforcement-env';
import { billingPeriodStart } from './usage-entitlement';

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

/** Ascending, so the report and the send order read chronologically. */
export const QUOTA_ALERT_THRESHOLDS = [80, 95] as const;

export function quotaAlertsEnabled(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  const v = env.ARIES_QUOTA_ALERTS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Every company's allowance, period consumption and credit balance in ONE
 * statement. The two LATERALs keep this a single round trip instead of 2N
 * queries across the tenant list.
 *
 * $1 = billing period start.
 */
export const SELECT_ALERT_CANDIDATES_SQL = `SELECT s.company_id,
            s.tier_key,
            s.monthly_task_allowance_override,
            s.monthly_token_allowance_override,
            c.monthly_task_allowance,
            c.monthly_token_allowance,
            o.name AS company_name,
            u.tasks_used,
            u.tokens_used,
            COALESCE(cr.credits, 0)::bigint AS credits
       FROM company_subscriptions s
       JOIN plan_rate_cards c ON c.tier_key = s.tier_key
       JOIN organizations o ON o.id = s.company_id
       LEFT JOIN LATERAL (
         SELECT sum(total_tasks)::bigint AS tasks_used,
                sum(total_tokens)::bigint AS tokens_used
           FROM daily_company_usage d
          WHERE d.company_id = s.company_id AND d.usage_date >= $1::date
       ) u ON TRUE
       LEFT JOIN LATERAL (
         SELECT sum(credits)::bigint AS credits
           FROM company_credit_ledger l
          WHERE l.company_id = s.company_id
            AND (l.expires_at IS NULL OR l.expires_at > now())
       ) cr ON TRUE
      WHERE o.kind = ANY($2::text[])`;

export const SELECT_WATERMARK_SQL = `SELECT rolled_through FROM usage_rollup_state WHERE id = 'hourly'`;

/**
 * Claim the alert. rowCount 1 means THIS tick won the right to send; 0 means it
 * was already sent for this company/period/threshold.
 */
export const CLAIM_ALERT_SQL = `INSERT INTO usage_alert_notifications (company_id, period_start, threshold, recipients)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (company_id, period_start, threshold) DO NOTHING`;

/** Workspace admins are the AC's "B2B Customer Admin". */
export const SELECT_ADMIN_EMAILS_SQL = `SELECT u.email
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1
        AND m.status = 'active'
        AND m.role = 'tenant_admin'
        AND u.email IS NOT NULL`;

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export type QuotaAlertReport = {
  skipped: boolean;
  skippedReason: 'disabled' | 'usage_not_metered' | null;
  periodStart: string;
  companiesChecked: number;
  /** Thresholds crossed this tick (claimed + attempted, one entry per email). */
  alertsSent: number;
  /** Crossings that were already alerted for this period. */
  alertsDeduped: number;
  errors: number;
};

export type RunQuotaAlertsOptions = {
  env?: Partial<Record<string, string | undefined>>;
  tenantKinds?: readonly OrganizationKind[];
  now?: () => Date;
  appBaseUrl?: string;
  /** Injectable so a test can assert the emails without a transport. */
  send?: typeof sendQuotaThresholdEmail;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function usedForMetric(row: Record<string, unknown>, metric: PlanEnforcementMetric): number | null {
  return asNumber(metric === 'tasks' ? row.tasks_used : row.tokens_used);
}

export async function runQuotaThresholdAlerts(
  db: Queryable,
  options: RunQuotaAlertsOptions = {},
): Promise<QuotaAlertReport> {
  const env = options.env ?? process.env;
  const tenantKinds = options.tenantKinds ?? resolveFleetTenantKinds(env);
  const now = options.now ?? (() => new Date());
  const periodStart = billingPeriodStart(now());
  const metric = resolvePlanEnforcementMetric(env);
  const send = options.send ?? sendQuotaThresholdEmail;
  const baseUrl = (options.appBaseUrl ?? env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  const usageUrl = `${baseUrl}/dashboard/settings`;

  const report: QuotaAlertReport = {
    skipped: true,
    skippedReason: null,
    periodStart,
    companiesChecked: 0,
    alertsSent: 0,
    alertsDeduped: 0,
    errors: 0,
  };

  if (!quotaAlertsEnabled(env)) {
    report.skippedReason = 'disabled';
    return report;
  }

  // With no watermark the rollup has never run: every company would read as 0%
  // used, which is an artifact of metering being off, not a measurement.
  const watermark = await db.query(SELECT_WATERMARK_SQL);
  const rolledThrough = (watermark.rows[0] as { rolled_through?: unknown } | undefined)?.rolled_through;
  if (rolledThrough === null || rolledThrough === undefined) {
    report.skippedReason = 'usage_not_metered';
    return report;
  }

  const candidates = await db.query(SELECT_ALERT_CANDIDATES_SQL, [periodStart, tenantKinds]);
  report.skipped = false;

  for (const raw of candidates.rows as Array<Record<string, unknown>>) {
    const companyId = asNumber(raw.company_id);
    if (companyId === null) continue;
    report.companiesChecked += 1;

    try {
      const tier: PlanTier = isPlanTier(raw.tier_key) ? raw.tier_key : DEFAULT_PLAN_TIER;
      const included = resolveIncludedAllowance(raw, metric, tier);
      // Unlimited plans have no threshold to cross.
      if (included === null) continue;

      const used = usedForMetric(raw, metric);
      // The metric itself is unreported for this company (the tokens case today).
      if (used === null) continue;

      const allowance = included + (asNumber(raw.credits) ?? 0);
      const { percentUsed } = computeQuotaFigures(used, allowance);
      if (percentUsed === null) continue;

      for (const threshold of QUOTA_ALERT_THRESHOLDS) {
        if (percentUsed < threshold) continue;

        const recipients = await db.query(SELECT_ADMIN_EMAILS_SQL, [companyId]);
        const emails = (recipients.rows as Array<{ email?: unknown }>)
          .map((r) => (typeof r.email === 'string' ? r.email.trim() : ''))
          .filter((email) => email.length > 0);
        if (emails.length === 0) continue; // nobody to tell; leave it unclaimed

        // Claim BEFORE sending: a crash mid-send costs one alert, while
        // claiming afterwards would re-send on every hourly tick until one
        // attempt finally succeeded.
        const claim = await db.query(CLAIM_ALERT_SQL, [
          companyId,
          periodStart,
          threshold,
          emails.length,
        ]);
        if (!claim.rowCount) {
          report.alertsDeduped += 1;
          continue;
        }

        const companyName =
          typeof raw.company_name === 'string' && raw.company_name.trim()
            ? raw.company_name.trim()
            : 'Your workspace';

        for (const email of emails) {
          await send({
            to: email,
            workspaceName: companyName,
            threshold,
            percentUsed,
            used,
            allowance,
            usageUrl,
          });
          report.alertsSent += 1;
        }
      }
    } catch (error) {
      // One company's failure must not stop the rest of the sweep.
      report.errors += 1;
      console.warn('[quota-alerts] company failed', {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
