#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const DEFAULT_PATHS = ['/', '/api/health/db'];

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePaths() {
  const raw = process.env.SCALE_SMOKE_PATHS?.trim();
  if (!raw) return DEFAULT_PATHS;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('/') ? item : `/${item}`));
}

function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index];
}

function requestUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

async function requestOnce(url) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'aries-scale-smoke/1.0',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    });
    await response.arrayBuffer();
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      ms: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function smokePath(baseUrl, path, concurrency) {
  const url = requestUrl(baseUrl, path);
  const results = await Promise.all(Array.from({ length: concurrency }, () => requestOnce(url)));
  const failures = results.filter((result) => !result.ok);
  const latencies = results.map((result) => result.ms);
  return {
    path,
    url,
    requests: results.length,
    failures: failures.length,
    statuses: results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] ?? 0) + 1;
      return acc;
    }, {}),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: Math.max(...latencies),
    firstError: failures.find((failure) => failure.error)?.error ?? null,
  };
}

async function main() {
  const baseUrl = process.env.SCALE_SMOKE_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  const concurrency = positiveInteger(process.env.SCALE_SMOKE_CONCURRENCY, 50);
  const p95BudgetMs = positiveInteger(process.env.SCALE_SMOKE_P95_BUDGET_MS, 2500);
  const paths = parsePaths();

  console.log(`[scale-smoke] base=${baseUrl} concurrency=${concurrency} p95BudgetMs=${p95BudgetMs}`);
  const summaries = [];
  for (const path of paths) {
    const summary = await smokePath(baseUrl, path, concurrency);
    summaries.push(summary);
    console.log(
      `[scale-smoke] ${summary.path} requests=${summary.requests} failures=${summary.failures} ` +
        `p50=${Math.round(summary.p50Ms)}ms p95=${Math.round(summary.p95Ms)}ms max=${Math.round(summary.maxMs)}ms ` +
        `statuses=${JSON.stringify(summary.statuses)}`,
    );
    if (summary.firstError) {
      console.log(`[scale-smoke] ${summary.path} firstError=${summary.firstError}`);
    }
  }

  const failed = summaries.filter((summary) => summary.failures > 0 || summary.p95Ms > p95BudgetMs);
  if (failed.length > 0) {
    console.error('[scale-smoke] FAILED: one or more paths had failures or exceeded p95 budget');
    process.exit(1);
  }

  console.log('[scale-smoke] passed');
}

main().catch((error) => {
  console.error(`[scale-smoke] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
