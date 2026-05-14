#!/usr/bin/env node
// Nightly synthetic content-creation regression gate.
//
// Three concerns, each independently fatal:
//   1. Prod liveness — public home page + /api/health/db respond healthy.
//   2. Marketing flow regression — npm run validate:marketing-flow (in-process orchestrator
//      contract tests including the four-stage Hermes callback fan-out path).
//   3. Execution provider gate — npm run validate:execution-provider (Hermes adapter +
//      callback route contracts).
//
// Run modes:
//   --preflight   verify required binaries and paths exist; do nothing else
//   --dry-run     print the plan; do not invoke tests or network
//   (default)     run all three concerns sequentially and emit a JSON summary
//
// Exit 0 on full success, 1 on any failure. Output is a single JSON object on the last
// line of stdout so the cron orchestrator can parse it directly.

import path from 'node:path'
import process from 'node:process'
import {
  emitSummary,
  hasFlag,
  parseArgs,
  preflightOrExit,
  repoRoot,
  resolveBinary,
  run,
} from './lib/common.mjs'

const PROD_URL = process.env.ARIES_CANARY_URL || 'https://aries.sugarandleather.com'
const PROD_HEALTH_PATH = '/api/health/db'
const PROD_HERMES_HEALTH_PATH = '/api/health/hermes'
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.ARIES_CANARY_TIMEOUT_MS || '15000', 10)

const SUITES = [
  {
    name: 'validate:marketing-flow',
    command: 'npm',
    args: ['run', 'validate:marketing-flow'],
    reason: 'orchestrator + Hermes one-shot fan-out contract',
  },
  {
    name: 'validate:execution-provider',
    command: 'npm',
    args: ['run', 'validate:execution-provider'],
    reason: 'Hermes adapter callback + run-store contract',
  },
]

const flags = parseArgs()
const preflightOnly = hasFlag(flags, '--preflight')
const dryRun = hasFlag(flags, '--dry-run')

const preflight = preflightOrExit('nightly-marketing-synthetic', {
  binaries: ['npm', 'node'],
  paths: [
    { path: path.join(repoRoot, 'package.json'), label: 'package.json' },
    { path: path.join(repoRoot, 'tests', 'marketing-job-flow.test.ts'), label: 'tests/marketing-job-flow.test.ts' },
    { path: path.join(repoRoot, 'tests', 'marketing-hermes-callback-flow.test.ts'), label: 'tests/marketing-hermes-callback-flow.test.ts' },
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}

if (dryRun) {
  emitSummary([
    'nightly-marketing-synthetic DRY-RUN',
    `- prod_url: ${PROD_URL}`,
    `- prod_health: ${PROD_URL}${PROD_HEALTH_PATH}`,
    `- prod_hermes_health: ${PROD_URL}${PROD_HERMES_HEALTH_PATH}`,
    `- npm: ${preflight.resolvedBinaries.npm}`,
    '- suites:',
    ...SUITES.map((s) => `  - ${s.name} (${s.reason})`),
  ])
  process.exit(0)
}

const startedAt = Date.now()

async function fetchWithTimeout(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'aries-nightly-synthetic/1.0' },
    })
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function checkProdLiveness() {
  const home = await fetchWithTimeout(PROD_URL)
  const health = await fetchWithTimeout(`${PROD_URL}${PROD_HEALTH_PATH}`)
  const hermes = await fetchWithTimeout(`${PROD_URL}${PROD_HERMES_HEALTH_PATH}`)
  return {
    home_status: home.status,
    home_ok: home.ok,
    home_error: home.error,
    health_status: health.status,
    health_ok: health.ok,
    health_error: health.error,
    hermes_status: hermes.status,
    hermes_ok: hermes.ok,
    hermes_error: hermes.error,
    ok: home.ok && health.ok && hermes.ok,
  }
}

function runSuite(suite) {
  const startedSuite = Date.now()
  const result = run(suite.command, suite.args, {
    cwd: repoRoot,
    env: { ...process.env, APP_BASE_URL: 'https://aries.example.com' },
  })
  const durationMs = Date.now() - startedSuite
  return {
    name: suite.name,
    reason: suite.reason,
    ok: result.ok,
    exit_code: result.code,
    duration_ms: durationMs,
    stderr_tail: result.stderr ? result.stderr.trim().split(/\r?\n/).slice(-6).join('\n') : '',
  }
}

const liveness = await checkProdLiveness()
const suiteResults = []
for (const suite of SUITES) {
  suiteResults.push(runSuite(suite))
}

const allSuitesPassed = suiteResults.every((r) => r.ok)
const status = liveness.ok && allSuitesPassed ? 'pass' : 'fail'
const durationMs = Date.now() - startedAt

const summary = {
  status,
  prod_url: PROD_URL,
  liveness,
  suites: suiteResults,
  duration_ms: durationMs,
  ran_at: new Date().toISOString(),
}

emitSummary([
  `nightly-marketing-synthetic ${status.toUpperCase()}`,
  `- prod_url: ${PROD_URL}`,
  `- home: ${liveness.home_status}${liveness.home_error ? ` (${liveness.home_error})` : ''}`,
  `- health: ${liveness.health_status}${liveness.health_error ? ` (${liveness.health_error})` : ''}`,
  `- hermes_health: ${liveness.hermes_status}${liveness.hermes_error ? ` (${liveness.hermes_error})` : ''}`,
  ...suiteResults.map((r) => `- ${r.name}: ${r.ok ? 'pass' : 'fail'} (${(r.duration_ms / 1000).toFixed(1)}s, exit=${r.exit_code})`),
  `- duration: ${(durationMs / 1000).toFixed(1)}s`,
  JSON.stringify(summary),
])

process.exit(status === 'pass' ? 0 : 1)
