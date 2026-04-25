import { spawn } from 'node:child_process';
import cluster from 'node:cluster';
import os from 'node:os';
import path from 'node:path';

const defaultPort = 3000;
const defaultWebConcurrency = 2;
const maxNumericWebConcurrency = 64;
const shutdownTimeoutMs = 10_000;
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

if (processManager === 'cluster') {
  startClusterRuntime();
} else {
  startSingleNodeRuntime();
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
  const workerInstanceIds = new Map();
  let shuttingDown = false;

  cluster.setupPrimary({
    exec: nextCliPath(),
    args: ['start', '-p', String(parsedPort)],
  });

  for (let instanceId = 0; instanceId < workerCount; instanceId += 1) {
    forkWorker(instanceId);
  }

  cluster.on('exit', (worker, code, signal) => {
    const instanceId = workerInstanceIds.get(worker.id) ?? 0;
    workerInstanceIds.delete(worker.id);

    if (shuttingDown) {
      if (activeWorkerCount() === 0) {
        process.exit(0);
      }
      return;
    }

    console.error(
      `[runtime] worker ${worker.process.pid ?? worker.id} exited (code=${String(code)} signal=${String(signal)}); restarting instance ${instanceId}`,
    );
    forkWorker(instanceId);
  });

  registerSignalHandlers((signal) => {
    shuttingDown = true;
    const workers = Object.values(cluster.workers ?? {}).filter(Boolean);
    if (workers.length === 0) {
      process.exit(0);
    }

    for (const worker of workers) {
      worker.kill(signal);
    }

    const forceExitTimer = setTimeout(() => {
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
    return defaultWebConcurrency;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultWebConcurrency;
  }

  return Math.min(parsed, maxNumericWebConcurrency);
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
  return path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
}

function registerSignalHandlers(handler) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => handler(signal));
  }
}
