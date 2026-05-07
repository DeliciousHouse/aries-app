import path from 'node:path';

import {
  runOAuthRefreshSweep,
  type SweeperRefreshOutcome,
  type SweeperReport,
  type SweeperWarningOutcome,
} from '@/backend/integrations/refresh-sweeper';

const USAGE = `Usage: tsx scripts/oauth-refresh-sweep.ts [--apply] [--dry-run] \
[--refresh-horizon-hours <int>] [--warning-window-days <int>] \
[--warning-cooldown-hours <int>] [--app-base-url <url>]

Sweeps oauth_connections for tokens within the refresh horizon and Meta/Instagram
long-lived tokens within the day-50 reconnect-warning window. Defaults to --dry-run.

In --apply mode:
  - Connections with token_expires_at < now()+refresh-horizon-hours are refreshed
    via the standard oauth refresh path. Unauthorized refresh failures flip the
    connection to reauthorization_required (handled inside oauthRefresh).
  - Meta/Instagram connections within warning-window-days of expiry trigger
    sendMetaReconnectWarningEmail to the tenant_admin email; deduplicated within
    warning-cooldown-hours via oauth_audit_events.

This script is invocation-only — there is no daemon, cron, or scheduler.
`;

type CliArgs = {
  dryRun: boolean;
  refreshHorizonHours?: number;
  warningWindowDays?: number;
  warningCooldownHours?: number;
  appBaseUrl?: string;
  showHelp: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: true, showHelp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      args.showHelp = true;
      continue;
    }
    if (flag === '--apply') {
      args.dryRun = false;
      continue;
    }
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (flag === '--refresh-horizon-hours') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--refresh-horizon-hours requires a positive integer');
      }
      args.refreshHorizonHours = parsed;
      i += 1;
      continue;
    }
    if (flag === '--warning-window-days') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--warning-window-days requires a positive integer');
      }
      args.warningWindowDays = parsed;
      i += 1;
      continue;
    }
    if (flag === '--warning-cooldown-hours') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--warning-cooldown-hours requires a positive integer');
      }
      args.warningCooldownHours = parsed;
      i += 1;
      continue;
    }
    if (flag === '--app-base-url') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--app-base-url requires a url argument');
      }
      args.appBaseUrl = value.trim();
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function describeRefreshOutcome(outcome: SweeperRefreshOutcome): string {
  switch (outcome.kind) {
    case 'refreshed':
      return `refreshed expires_at=${outcome.tokenExpiresAt ?? 'null'}`;
    case 'skipped_unchanged':
      return 'skipped (concurrent refresh already rotated)';
    case 'reauth_required':
      return `reauth_required: ${outcome.errorMessage}`;
    case 'unknown_failure':
      return `failed: ${outcome.errorMessage}`;
    default:
      return 'unknown';
  }
}

function describeWarningOutcome(outcome: SweeperWarningOutcome): string {
  switch (outcome.kind) {
    case 'sent':
      return `sent (days=${outcome.daysUntilExpiry})`;
    case 'skipped_already_warned':
      return 'skipped_already_warned';
    case 'skipped_no_email':
      return 'skipped_no_email';
    case 'skipped_dry_run':
      return 'skipped_dry_run';
    case 'failed':
      return `failed: ${outcome.errorMessage}`;
    default:
      return 'unknown';
  }
}

function summarize(report: SweeperReport): string {
  return [
    `mode=${report.dryRun ? 'dry-run' : 'apply'}`,
    `scanned_at=${report.scannedAt}`,
    `refresh_horizon_hours=${report.refreshHorizonHours}`,
    `warning_window_days=${report.warningWindowDays}`,
    `warning_cooldown_hours=${report.warningCooldownHours}`,
    `refresh_candidates=${report.refreshCandidates.length}`,
    `warning_candidates=${report.warningCandidates.length}`,
    `refresh_results=${report.refreshResults.length}`,
    `warning_results=${report.warningResults.length}`,
    `errors=${report.errors}`,
  ].join(' ');
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[oauth-refresh-sweep] ${(err as Error)?.message}\n${USAGE}`);
    return 2;
  }

  if (args.showHelp) {
    process.stdout.write(USAGE);
    return 0;
  }

  process.stdout.write(
    `[oauth-refresh-sweep] starting mode=${args.dryRun ? 'dry-run' : 'apply'}\n`,
  );

  const report = await runOAuthRefreshSweep({
    dryRun: args.dryRun,
    refreshHorizonHours: args.refreshHorizonHours,
    warningWindowDays: args.warningWindowDays,
    warningCooldownHours: args.warningCooldownHours,
    appBaseUrl: args.appBaseUrl,
  });

  process.stdout.write(`[oauth-refresh-sweep] ${summarize(report)}\n`);

  for (const candidate of report.refreshCandidates) {
    process.stdout.write(
      `[oauth-refresh-sweep] refresh-candidate connection_id=${candidate.connectionId} tenant_id=${candidate.tenantId} provider=${candidate.provider} token_expires_at=${candidate.tokenExpiresAt}\n`,
    );
  }
  for (const result of report.refreshResults) {
    process.stdout.write(
      `[oauth-refresh-sweep] refresh-result connection_id=${result.candidate.connectionId} provider=${result.candidate.provider} ${describeRefreshOutcome(result.outcome)}\n`,
    );
  }
  for (const candidate of report.warningCandidates) {
    process.stdout.write(
      `[oauth-refresh-sweep] warning-candidate connection_id=${candidate.connectionId} tenant_id=${candidate.tenantId} provider=${candidate.provider} token_expires_at=${candidate.tokenExpiresAt} days=${candidate.daysUntilExpiry} email=${candidate.operatorEmail ?? 'null'}\n`,
    );
  }
  for (const result of report.warningResults) {
    process.stdout.write(
      `[oauth-refresh-sweep] warning-result connection_id=${result.candidate.connectionId} tenant_id=${result.candidate.tenantId} provider=${result.candidate.provider} ${describeWarningOutcome(result.outcome)}\n`,
    );
  }

  if (report.errors > 0) {
    return 1;
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry.endsWith('oauth-refresh-sweep.ts') || entry.endsWith('oauth-refresh-sweep.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    try {
      const code = await main();
      process.exit(code);
    } catch (err) {
      process.stderr.write(`[oauth-refresh-sweep] FATAL ${(err as Error)?.message}\n`);
      process.exit(1);
    }
  })();
}

export { main as oauthRefreshSweepCli, parseArgs };
