import { spawn, spawnSync } from 'node:child_process';
import cluster from 'node:cluster';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPort = 3000;
const defaultWebConcurrency = 2;
const maxNumericWebConcurrency = 64;
const defaultWorkerMaxRestarts = 5;
const shutdownTimeoutMs = 10_000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
/** @type {import('node:child_process').ChildProcess | null} */
let partnerOutboxChild = null;
/** @type {import('node:child_process').ChildProcess | null} */
let staleRunReaperChild = null;
/** @type {import('node:child_process').ChildProcess | null} */
let hermesKanbanGcChild = null;
/** @type {import('node:child_process').ChildProcess | null} */
let hermesReconcilerChild = null;
let hermesReconcilerStopping = false;
/** Timestamps (ms) of recent reconciler respawns — windowed crash-loop guard. */
let hermesReconcilerRestartTimes = [];
const hermesReconcilerRestartWindowMs = 60_000;
const hermesReconcilerMaxRestartsPerWindow = 5;
const hermesReconcilerRestartDelayMs = 2_000;
const rawPort = process.env.PORT?.trim();
const parsedPort = rawPort ? Number(rawPort) : defaultPort;
const isValidPort = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535;

if (!isValidPort) {
  console.error(`Invalid PORT value "${rawPort}". Expected integer 1-65535.`);
  process.exit(1);
}

const processManager = normalizeProcessManager(process.env.ARIES_PROCESS_MANAGER);
if (!processManager) {
  console.error(
    `Invalid ARIES_PROCESS_MANAGER value "${process.env.ARIES_PROCESS_MANAGER}". Expected "cluster" or "node".`,
  );
  process.exit(1);
}

const runtimeEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: String(parsedPort),
};

// Apply DB schema before forking any workers. init-db.js uses `CREATE TABLE
// IF NOT EXISTS` / `ALTER ... IF NOT EXISTS`, so this is idempotent and safe
// to re-run on every container start. We block here because feature code
// (e.g. partner_attribution_outbox enqueue) assumes the schema exists; if
// init-db fails we don't want to fork workers and serve traffic that will
// roll back transactions.
const skipInit = (process.env.ARIES_SKIP_DB_INIT ?? '').trim().toLowerCase();
if (skipInit !== '1' && skipInit !== 'true') {
  const initDbPath = path.join(projectRoot, 'scripts', 'init-db.js');
  const initResult = spawnSync(process.execPath, [initDbPath], {
    stdio: 'inherit',
    env: runtimeEnv,
  });
  if (initResult.status !== 0) {
    console.error(
      `[runtime] init-db.js exited with code=${String(initResult.status)} signal=${String(initResult.signal ?? '')}; refusing to start workers`,
    );
    process.exit(1);
  }
}

if (processManager === 'cluster') {
  startClusterRuntime();
} else {
  startSingleNodeRuntime();
}

function partnerAttributionWorkerEnabled() {
  const v = process.env.PARTNER_ATTRIBUTION_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function reaperWorkerEnabled() {
  const v = process.env.ARIES_REAPER_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

function hermesKanbanGcWorkerEnabled() {
  const v = process.env.ARIES_KANBAN_GC_ENABLED?.trim().toLowerCase();
  if (!v) {
    return true;
  }
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

function hermesReconcilerWorkerEnabled() {
  // Default ON: durable replacement for the in-process Hermes poll-bridge.
  // Disable only with an explicit 0/false/no/off.
  const v = process.env.ARIES_RECONCILER_ENABLED?.trim().toLowerCase();
  if (!v) {
    return true;
  }
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

function spawnPartnerOutboxWorker() {
  if (!partnerAttributionWorkerEnabled()) {
    return;
  }
  const tsx = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const worker = path.join(projectRoot, 'scripts', 'partner-attribution-outbox-worker.ts');
  try {
    partnerOutboxChild = spawn(process.execPath, [tsx, worker], {
      stdio: 'inherit',
      env: { ...runtimeEnv },
      detached: false,
    });
    partnerOutboxChild.on('exit', (code, signal) => {
      partnerOutboxChild = null;
      console.error(
        `[runtime] partner attribution outbox worker exited code=${String(code)} signal=${String(signal ?? '')}`,
      );
    });
    console.log('[runtime] started partner attribution outbox worker');
  } catch (error) {
    console.error('[runtime] failed to start partner attribution outbox worker', error);
  }
}

function stopPartnerOutboxWorker() {
  if (partnerOutboxChild && !partnerOutboxChild.killed) {
    partnerOutboxChild.kill('SIGTERM');
    partnerOutboxChild = null;
  }
}

function spawnStaleRunReaperWorker() {
  if (!reaperWorkerEnabled()) {
    return;
  }
  const tsx = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const worker = path.join(projectRoot, 'scripts', 'stale-run-reaper-worker.ts');
  try {
    staleRunReaperChild = spawn(process.execPath, [tsx, worker], {
      stdio: 'inherit',
      env: { ...runtimeEnv },
      detached: false,
    });
    staleRunReaperChild.on('exit', (code, signal) => {
      staleRunReaperChild = null;
      console.error(
        `[runtime] stale-run reaper worker exited code=${String(code)} signal=${String(signal ?? '')}`,
      );
    });
    console.log('[runtime] started stale-run reaper worker');
  } catch (error) {
    console.error('[runtime] failed to start stale-run reaper worker', error);
  }
}

function stopStaleRunReaperWorker() {
  if (staleRunReaperChild && !staleRunReaperChild.killed) {
    staleRunReaperChild.kill('SIGTERM');
    staleRunReaperChild = null;
  }
}

function spawnHermesKanbanGcWorker() {
  if (!hermesKanbanGcWorkerEnabled()) {
    return;
  }
  const tsx = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const worker = path.join(projectRoot, 'scripts', 'hermes-kanban-gc-worker.ts');
  try {
    hermesKanbanGcChild = spawn(process.execPath, [tsx, worker], {
      stdio: 'inherit',
      env: { ...runtimeEnv },
      detached: false,
    });
    hermesKanbanGcChild.on('exit', (code, signal) => {
      hermesKanbanGcChild = null;
      console.error(
        `[runtime] hermes kanban gc worker exited code=${String(code)} signal=${String(signal ?? '')}`,
      );
    });
    console.log('[runtime] started hermes kanban gc worker');
  } catch (error) {
    console.error('[runtime] failed to start hermes kanban gc worker', error);
  }
}

function stopHermesKanbanGcWorker() {
  if (hermesKanbanGcChild && !hermesKanbanGcChild.killed) {
    hermesKanbanGcChild.kill('SIGTERM');
    hermesKanbanGcChild = null;
  }
}

function spawnHermesReconcilerWorker() {
  if (!hermesReconcilerWorkerEnabled()) {
    return;
  }
  hermesReconcilerStopping = false;
  const tsx = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const worker = path.join(projectRoot, 'scripts', 'hermes-reconciler-worker.ts');
  try {
    hermesReconcilerChild = spawn(process.execPath, [tsx, worker], {
      stdio: 'inherit',
      // Tag this process's Postgres connections (pg_stat_activity) and keep a
      // small dedicated pool ceiling per guardrail #1 — ingestion runs here too,
      // but sequentially, so a handful of connections is plenty.
      env: { ...runtimeEnv, APP_INSTANCE_ID: 'hermes-reconciler', DB_POOL_MAX: '5' },
      detached: false,
    });
    hermesReconcilerChild.on('exit', (code, signal) => {
      hermesReconcilerChild = null;
      console.error(
        `[runtime] hermes reconciler worker exited code=${String(code)} signal=${String(signal ?? '')}`,
      );
      // This worker is the durable replacement for the Hermes poll-bridge — if
      // it dies, marketing jobs silently stop ingesting. Auto-respawn unless we
      // asked it to stop during shutdown. The guard is WINDOWED, not a lifetime
      // cap: only a tight crash loop (many restarts inside the window, e.g. an
      // import error) gives up; transient crashes spread over the container's
      // (weeks-long) lifetime always recover, because old timestamps age out.
      if (hermesReconcilerStopping) {
        return;
      }
      const nowMs = Date.now();
      hermesReconcilerRestartTimes = hermesReconcilerRestartTimes.filter(
        (t) => nowMs - t < hermesReconcilerRestartWindowMs,
      );
      if (hermesReconcilerRestartTimes.length >= hermesReconcilerMaxRestartsPerWindow) {
        console.error(
          `[runtime] hermes reconciler worker crashed ${hermesReconcilerMaxRestartsPerWindow}x within ${hermesReconcilerRestartWindowMs}ms; not restarting (crash loop). Restart the container after fixing.`,
        );
        return;
      }
      hermesReconcilerRestartTimes.push(nowMs);
      console.error(
        `[runtime] respawning hermes reconciler worker (${hermesReconcilerRestartTimes.length}/${hermesReconcilerMaxRestartsPerWindow} within ${hermesReconcilerRestartWindowMs}ms)`,
      );
      const restartTimer = setTimeout(() => spawnHermesReconcilerWorker(), hermesReconcilerRestartDelayMs);
      restartTimer.unref();
    });
    console.log('[runtime] started hermes reconciler worker');
  } catch (error) {
    console.error('[runtime] failed to start hermes reconciler worker', error);
  }
}

function stopHermesReconcilerWorker() {
  hermesReconcilerStopping = true;
  if (hermesReconcilerChild && !hermesReconcilerChild.killed) {
    hermesReconcilerChild.kill('SIGTERM');
    hermesReconcilerChild = null;
  }
}

function normalizeProcessManager(rawValue) {
  const normalized = rawValue?.trim().toLowerCase() || 'cluster';
  if (normalized === 'cluster' || normalized === 'node') {
    return normalized;
  }
  if (normalized === 'pm2') {
    console.warn('[runtime] ARIES_PROCESS_MANAGER=pm2 is not bundled; using native cluster runtime.');
    return 'cluster';
  }
  return null;
}

function startClusterRuntime() {
  if (!cluster.isPrimary) {
    return;
  }

  const workerCount = resolveWebConcurrency(process.env.ARIES_WEB_CONCURRENCY, process.env.WEB_CONCURRENCY);
  const maxWorkerRestarts = resolvePositiveIntegerEnv(
    process.env.ARIES_WORKER_MAX_RESTARTS,
    'ARIES_WORKER_MAX_RESTARTS',
    defaultWorkerMaxRestarts,
  );
  const workerInstanceIds = new Map();
  const workerRestartCounts = new Map();
  let shuttingDown = false;

  cluster.setupPrimary({
    exec: nextCliPath(),
    args: ['start', '-p', String(parsedPort)],
  });

  for (let instanceId = 0; instanceId < workerCount; instanceId += 1) {
    forkWorker(instanceId);
  }

  spawnPartnerOutboxWorker();
  spawnStaleRunReaperWorker();
  spawnHermesKanbanGcWorker();
  spawnHermesReconcilerWorker();

  cluster.on('exit', (worker, code, signal) => {
    const instanceId = workerInstanceIds.get(worker.id) ?? 0;
    workerInstanceIds.delete(worker.id);

    if (shuttingDown) {
      if (activeWorkerCount() === 0) {
        process.exit(0);
      }
      return;
    }

    const restartCount = (workerRestartCounts.get(instanceId) ?? 0) + 1;
    workerRestartCounts.set(instanceId, restartCount);

    if (restartCount > maxWorkerRestarts) {
      console.error(
        `[runtime] worker instance ${instanceId} exceeded ${maxWorkerRestarts} restart attempts; not restarting`,
      );
      if (activeWorkerCount() === 0) {
        process.exit(1);
      }
      return;
    }

    console.error(
      `[runtime] worker ${worker.process.pid ?? worker.id} exited (code=${String(code)} signal=${String(signal)}); restarting instance ${instanceId} attempt ${restartCount}/${maxWorkerRestarts}`,
    );
    forkWorker(instanceId);
  });

  registerSignalHandlers((signal) => {
    shuttingDown = true;
    stopPartnerOutboxWorker();
    stopStaleRunReaperWorker();
    stopHermesKanbanGcWorker();
    stopHermesReconcilerWorker();
    const workers = Object.values(cluster.workers ?? {}).filter(Boolean);
    if (workers.length === 0) {
      process.exit(0);
    }

    for (const worker of workers) {
      worker.kill(signal);
    }

    const forceExitTimer = setTimeout(() => {
      stopPartnerOutboxWorker();
      stopStaleRunReaperWorker();
      stopHermesKanbanGcWorker();
      stopHermesReconcilerWorker();
      for (const worker of Object.values(cluster.workers ?? {}).filter(Boolean)) {
        worker.kill('SIGKILL');
      }
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref();
  });

  function forkWorker(instanceId) {
    const worker = cluster.fork({
      ...runtimeEnv,
      APP_INSTANCE_ID: String(instanceId),
    });
    workerInstanceIds.set(worker.id, instanceId);
  }
}

function startSingleNodeRuntime() {
  spawnPartnerOutboxWorker();
  spawnStaleRunReaperWorker();
  spawnHermesKanbanGcWorker();
  spawnHermesReconcilerWorker();

  const child = spawn(process.execPath, [nextCliPath(), 'start', '-p', String(parsedPort)], {
    stdio: 'inherit',
    env: {
      ...runtimeEnv,
      APP_INSTANCE_ID: process.env.APP_INSTANCE_ID || '0',
    },
  });

  const forwardedSignals = new Set();
  registerSignalHandlers((signal) => {
    forwardedSignals.add(signal);
    stopPartnerOutboxWorker();
    stopStaleRunReaperWorker();
    stopHermesKanbanGcWorker();
    stopHermesReconcilerWorker();
    if (!child.killed) {
      child.kill(signal);
    }
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(forwardedSignals.has(signal) ? 0 : 1);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(`Failed to start node runtime: ${String(error?.message || error)}`);
    process.exit(1);
  });
}

function resolveWebConcurrency(rawAriesConcurrency, rawGenericConcurrency) {
  const rawValue = firstNonEmpty(rawAriesConcurrency, rawGenericConcurrency);
  if (!rawValue) {
    return defaultWebConcurrency;
  }

  if (rawValue.toLowerCase() === 'max') {
    return Math.max(1, Math.min(availableParallelism(), maxNumericWebConcurrency));
  }

  if (!/^\d+$/.test(rawValue)) {
    failInvalidPositiveInteger('ARIES_WEB_CONCURRENCY/WEB_CONCURRENCY', rawValue);
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    failInvalidPositiveInteger('ARIES_WEB_CONCURRENCY/WEB_CONCURRENCY', rawValue);
  }

  return Math.min(parsed, maxNumericWebConcurrency);
}

function resolvePositiveIntegerEnv(rawValue, label, defaultValue) {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return defaultValue;
  }
  if (!/^\d+$/.test(trimmed)) {
    failInvalidPositiveInteger(label, trimmed);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    failInvalidPositiveInteger(label, trimmed);
  }
  return parsed;
}

function failInvalidPositiveInteger(label, value) {
  console.error(`Invalid ${label} value "${value}". Expected a positive integer.`);
  process.exit(1);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function availableParallelism() {
  if (typeof os.availableParallelism === 'function') {
    return os.availableParallelism();
  }
  return os.cpus().length;
}

function activeWorkerCount() {
  return Object.values(cluster.workers ?? {}).filter(Boolean).length;
}

function nextCliPath() {
  return path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
}

function registerSignalHandlers(handler) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => handler(signal));
  }
}
