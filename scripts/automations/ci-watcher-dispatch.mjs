import process from 'node:process'
import {
  emitSummary,
  parseArgs,
  preflightOrExit,
  repoRoot,
  run,
} from './lib/common.mjs'
import {
  CI_WATCHER_LABEL,
  CI_WATCHER_PROJECT,
  CI_WATCHER_REPO,
  ciWatcherLogPath,
  parseIssuesJson,
  parseSessionsJson,
  planDispatch,
  readLog,
  recordEvents,
  writeLog,
} from './lib/ci-watcher-dispatch.mjs'

const flags = parseArgs()
const dryRun = flags.has('--dry-run')
const preflightOnly = flags.has('--preflight')

preflightOrExit(
  'CI WATCHER DISPATCH',
  { binaries: ['gh', 'ao'] },
  { preflightOnly },
)

if (preflightOnly) {
  process.exit(0)
}

function logLine(event) {
  const { action, issue, stage, reason, detail } = event
  const parts = [`- ${action}`]
  if (typeof issue === 'number') parts.push(`issue=#${issue}`)
  if (stage) parts.push(`stage=${stage}`)
  if (reason) parts.push(`reason=${reason}`)
  if (detail) parts.push(`detail=${detail}`)
  return parts.join(' ')
}

function fetchIssues() {
  const result = run('gh', [
    'issue',
    'list',
    '--repo',
    CI_WATCHER_REPO,
    '--label',
    CI_WATCHER_LABEL,
    '--state',
    'open',
    '--json',
    'number,title,labels',
    '--limit',
    '100',
  ])
  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || `gh exited ${result.code}`, issues: [] }
  }
  return { ok: true, issues: parseIssuesJson(result.stdout) }
}

function fetchSessions() {
  const result = run('ao', ['session', 'ls', '-p', CI_WATCHER_PROJECT, '--json'])
  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || `ao exited ${result.code}`, sessions: [] }
  }
  return { ok: true, sessions: parseSessionsJson(result.stdout) }
}

function spawnSession(issueNumber) {
  const result = run('ao', ['spawn', String(issueNumber)], { cwd: repoRoot })
  if (!result.ok) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || `ao exited ${result.code}`).trim(),
    }
  }
  return { ok: true }
}

const summaryLines = [`CI WATCHER DISPATCH ${dryRun ? '[dry-run]' : ''}`.trim()]
const events = []

try {
  const issuesResult = fetchIssues()
  if (!issuesResult.ok) {
    events.push({ action: 'error', stage: 'gh-issue-list', detail: issuesResult.error })
    summaryLines.push(`- gh-issue-list failed: ${issuesResult.error}`)
  }

  const sessionsResult = fetchSessions()
  if (!sessionsResult.ok) {
    events.push({ action: 'error', stage: 'ao-session-ls', detail: sessionsResult.error })
    summaryLines.push(`- ao-session-ls failed: ${sessionsResult.error}`)
  }

  if (issuesResult.ok && sessionsResult.ok) {
    const { toSpawn, toSkip } = planDispatch({
      issues: issuesResult.issues,
      sessions: sessionsResult.sessions,
    })

    summaryLines.push(
      `- open ci-watcher issues: ${issuesResult.issues.length}`,
      `- sessions inspected: ${sessionsResult.sessions.length}`,
      `- skipped (existing session): ${toSkip.length}`,
      `- ${dryRun ? 'would spawn' : 'spawn attempts'}: ${toSpawn.length}`,
    )

    for (const skip of toSkip) {
      events.push({ action: 'skipped', issue: skip.number, reason: skip.reason })
    }

    for (const target of toSpawn) {
      if (dryRun) {
        events.push({ action: 'would-spawn', issue: target.number })
        continue
      }
      const spawnResult = spawnSession(target.number)
      if (spawnResult.ok) {
        events.push({ action: 'spawned', issue: target.number })
      } else {
        events.push({ action: 'error', stage: 'ao-spawn', issue: target.number, detail: spawnResult.error })
      }
    }
  }
} catch (error) {
  events.push({
    action: 'error',
    stage: 'dispatcher',
    detail: error instanceof Error ? error.message : String(error),
  })
  summaryLines.push(`- dispatcher error: ${error instanceof Error ? error.message : String(error)}`)
}

if (events.length === 0) {
  events.push({ action: 'noop' })
}

for (const event of events) {
  summaryLines.push(logLine(event))
}

if (!dryRun) {
  try {
    const log = readLog()
    writeLog(recordEvents(log, events), ciWatcherLogPath)
  } catch (error) {
    summaryLines.push(
      `- log-write warning: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

emitSummary(summaryLines)
// Fail-safe: never take the cron down on transient errors. Individual failures
// are recorded in the log and summary above.
process.exit(0)
