/**
 * Hermes kanban GC worker — spawned by start-runtime.mjs when
 * ARIES_KANBAN_GC_ENABLED is not disabled. Archives completed kanban tasks
 * older than ARIES_KANBAN_GC_RETENTION_DAYS (default 7 days), then delegates
 * workspace/log/event pruning to the existing `hermes kanban gc` CLI.
 */
import 'dotenv/config';

import { spawn } from 'node:child_process';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RETENTION_DAYS = 7;
const ARCHIVE_BATCH_SIZE = 100;

type HermesTask = {
  id?: unknown;
  status?: unknown;
  completed_at?: unknown;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type GcReport = {
  archived: number;
  workspacesRemoved: number;
  errors: number;
};

let gcRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;

function truthyUnlessDisabled(rawValue: string | undefined): boolean {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}

function resolvePositiveInteger(rawValue: string | undefined, defaultValue: number): number {
  const trimmed = rawValue?.trim();
  if (!trimmed) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function resolveIntervalMs(): number {
  return resolvePositiveInteger(process.env.ARIES_KANBAN_GC_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

function resolveRetentionDays(): number {
  return resolvePositiveInteger(process.env.ARIES_KANBAN_GC_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

function resolveHermesCommand(): string {
  return process.env.ARIES_KANBAN_GC_HERMES_BIN?.trim() || 'hermes';
}

function runHermes(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveHermesCommand(), args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const suffix = stderr.trim() || stdout.trim() || `signal=${String(signal ?? '')}`;
      reject(new Error(`hermes ${args.join(' ')} exited code=${String(code)} ${suffix}`));
    });
  });
}

function parseCompletedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
    const parsedMs = Date.parse(value);
    if (Number.isFinite(parsedMs)) {
      return Math.floor(parsedMs / 1000);
    }
  }
  return null;
}

function selectArchiveCandidates(tasks: HermesTask[], retentionDays: number, nowSeconds: number): string[] {
  const retentionSeconds = retentionDays * 24 * 60 * 60;
  const cutoffSeconds = nowSeconds - retentionSeconds;

  return tasks
    .filter((task): task is HermesTask & { id: string } => {
      if (task.status !== 'done' || typeof task.id !== 'string' || task.id.length === 0) {
        return false;
      }
      const completedAt = parseCompletedAt(task.completed_at);
      return completedAt !== null && completedAt < cutoffSeconds;
    })
    .map((task) => task.id);
}

function parseWorkspaceDeleteCount(output: string): number {
  const match = output.match(/GC complete:\s*(\d+)\s+workspace\(s\)/i);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listDoneTasks(): Promise<HermesTask[]> {
  const { stdout } = await runHermes(['kanban', 'list', '--status', 'done', '--json']);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('hermes kanban list --json returned a non-array payload');
  }
  return parsed as HermesTask[];
}

async function archiveTasks(taskIds: string[]): Promise<number> {
  let archived = 0;
  for (let i = 0; i < taskIds.length; i += ARCHIVE_BATCH_SIZE) {
    const batch = taskIds.slice(i, i + ARCHIVE_BATCH_SIZE);
    if (batch.length === 0) continue;
    await runHermes(['kanban', 'archive', ...batch]);
    archived += batch.length;
  }
  return archived;
}

async function runGcOnce(): Promise<GcReport> {
  const report: GcReport = { archived: 0, workspacesRemoved: 0, errors: 0 };
  const retentionDays = resolveRetentionDays();

  try {
    const tasks = await listDoneTasks();
    const candidates = selectArchiveCandidates(tasks, retentionDays, Math.floor(Date.now() / 1000));
    report.archived = await archiveTasks(candidates);
  } catch (error) {
    report.errors += 1;
    console.error('[hermes-kanban-gc] archive phase failed', error);
  }

  try {
    const gcResult = await runHermes(['kanban', 'gc']);
    const gcOutput = `${gcResult.stdout}\n${gcResult.stderr}`;
    report.workspacesRemoved = parseWorkspaceDeleteCount(gcOutput);
  } catch (error) {
    report.errors += 1;
    console.error('[hermes-kanban-gc] gc phase failed', error);
  }

  return report;
}

async function tick(): Promise<void> {
  if (gcRunning) {
    console.warn('[hermes-kanban-gc] previous run still active; skipping overlapping tick');
    return;
  }

  gcRunning = true;
  try {
    const report = await runGcOnce();
    console.log(
      `[hermes-kanban-gc] summary ${JSON.stringify({
        archived: report.archived,
        workspaces_removed: report.workspacesRemoved,
        errors: report.errors,
      })}`,
    );
  } catch (error) {
    console.error('[hermes-kanban-gc] tick failed', error);
  } finally {
    gcRunning = false;
  }
}

async function main(): Promise<void> {
  if (!truthyUnlessDisabled(process.env.ARIES_KANBAN_GC_ENABLED)) {
    console.log('[hermes-kanban-gc] ARIES_KANBAN_GC_ENABLED is off; exiting.');
    process.exit(0);
  }

  const intervalMs = resolveIntervalMs();
  const retentionDays = resolveRetentionDays();
  console.log(`[hermes-kanban-gc] starting; interval=${intervalMs}ms retention_days=${retentionDays}`);

  await tick();

  if (process.env.ARIES_KANBAN_GC_RUN_ONCE?.trim() === '1') {
    process.exit(0);
  }

  intervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
    }
    process.exit(0);
  });
}

void main();

export {
  parseCompletedAt,
  parseWorkspaceDeleteCount,
  resolveIntervalMs,
  resolveRetentionDays,
  selectArchiveCandidates,
};
