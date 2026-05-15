import path from 'node:path';

import { resolveDataRoot } from '@/lib/runtime-paths';
import {
  runStaleRunReaper,
  staleRunReaperThresholdsByStage,
  type StaleRunReaperReport,
} from '@/backend/marketing/stale-run-reaper';

const USAGE = `Usage: tsx scripts/reap-stale-runs.ts [--apply] [--dry-run] [--data-root <path>] [--threshold-ms <int>]

Sweeps marketing-job runtime documents under DATA_ROOT/generated/draft/marketing-jobs
and marks runs that have been silent past their per-stage timeout as failed_stale.

Per-stage defaults (overridable via env vars):
  research:   10 min  (STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS)
  strategy:    5 min  (STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS)
  production: 90 min  (STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS)
  publish:    30 min  (STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS)

--threshold-ms <int>  Override all per-stage thresholds with a single value (ms).
                      When omitted, per-stage thresholds (env or defaults above) apply.

Defaults to --dry-run. Pass --apply to mutate runtime docs. Never deletes files.
Idempotent: a second --apply finds zero candidates because reaped runs land in
status='failed_stale'.
`;

type CliArgs = {
  dryRun: boolean;
  dataRoot?: string;
  thresholdMs?: number;
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
    if (flag === '--data-root') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--data-root requires a path argument');
      }
      args.dataRoot = path.normalize(value);
      i += 1;
      continue;
    }
    if (flag === '--threshold-ms') {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--threshold-ms requires a positive integer');
      }
      args.thresholdMs = parsed;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function summarize(report: StaleRunReaperReport): string {
  const thresholdSummary = `research:${report.thresholdsByStage.research},strategy:${report.thresholdsByStage.strategy},production:${report.thresholdsByStage.production},publish:${report.thresholdsByStage.publish}`;
  const lines = [
    `mode=${report.dryRun ? 'dry-run' : 'apply'}`,
    ...(report.thresholdMs !== null ? [`threshold_ms_override=${report.thresholdMs}`] : []),
    `thresholds_by_stage=${thresholdSummary}`,
    `scanned=${report.scanned}`,
    `candidates=${report.candidates.length}`,
    `mutated=${report.mutated}`,
    `skipped=${report.skipped}`,
    `errors=${report.errors}`,
  ];
  return lines.join(' ');
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[reap-stale-runs] ${(err as Error)?.message}\n${USAGE}`);
    return 2;
  }

  if (args.showHelp) {
    process.stdout.write(USAGE);
    return 0;
  }

  const dataRoot = args.dataRoot ?? resolveDataRoot();
  // When --threshold-ms is supplied, runStaleRunReaper will apply it uniformly across all stages
  // and reflect that in report.thresholdsByStage. Let the reaper derive the effective per-stage
  // map so that what we log here matches what report.thresholdsByStage will contain.
  const effectiveThresholdsByStage = args.thresholdMs
    ? {
        research: args.thresholdMs,
        strategy: args.thresholdMs,
        production: args.thresholdMs,
        publish: args.thresholdMs,
      }
    : staleRunReaperThresholdsByStage();

  process.stdout.write(
    `[reap-stale-runs] starting mode=${args.dryRun ? 'dry-run' : 'apply'} dataRoot=${dataRoot}${args.thresholdMs !== undefined ? ` threshold_ms_override=${args.thresholdMs}` : ''} thresholds_by_stage=${JSON.stringify(effectiveThresholdsByStage)}\n`,
  );

  const report = await runStaleRunReaper({
    dataRoot,
    dryRun: args.dryRun,
    thresholdMs: args.thresholdMs,
  });

  process.stdout.write(`[reap-stale-runs] ${summarize(report)}\n`);

  for (const candidate of report.candidates) {
    process.stdout.write(
      `[reap-stale-runs] candidate jobId=${candidate.jobId} tenant_id=${candidate.tenantId} state=${candidate.state} status=${candidate.status} stage=${candidate.stage} silent_ms=${candidate.silentMs} mutated=${candidate.mutated}\n`,
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
    return entry.endsWith('reap-stale-runs.ts') || entry.endsWith('reap-stale-runs.js');
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
      process.stderr.write(`[reap-stale-runs] FATAL ${(err as Error)?.message}\n`);
      process.exit(1);
    }
  })();
}

export { main as reapStaleRunsCli, parseArgs };
