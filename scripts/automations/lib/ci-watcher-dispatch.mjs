import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ensureDir, repoRoot } from './common.mjs'

export const ciWatcherLogPath = path.join(repoRoot, 'data', 'ci-watcher-dispatch-log.json')
export const CI_WATCHER_LABEL = 'ci-watcher'
export const CI_WATCHER_REPO = 'DeliciousHouse/aries-app'
export const CI_WATCHER_PROJECT = 'aries-app'

const MAX_LOG_ENTRIES = 500

function emptyLog() {
  return {
    version: 1,
    description:
      'Dispatcher log for ao worker sessions spawned from GitHub issues tagged ci-watcher. Appended by scripts/automations/ci-watcher-dispatch.mjs.',
    lastRunAt: null,
    events: [],
  }
}

export function readLog(logPath = ciWatcherLogPath) {
  try {
    const raw = readFileSync(logPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
      return { ...emptyLog(), ...parsed }
    }
  } catch {
    /* fall through */
  }
  return emptyLog()
}

export function writeLog(log, logPath = ciWatcherLogPath) {
  ensureDir(path.dirname(logPath))
  const trimmed = {
    ...log,
    events: log.events.slice(-MAX_LOG_ENTRIES),
  }
  writeFileSync(logPath, `${JSON.stringify(trimmed, null, 2)}\n`)
}

export function normalizeIssueRef(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim().toLowerCase()
}

export function buildSessionIssueSet(sessions) {
  const set = new Set()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const ref = normalizeIssueRef(session?.issueId)
    if (ref) set.add(ref)
  }
  return set
}

export function planDispatch({ issues, sessions }) {
  const sessionIssues = buildSessionIssueSet(sessions)
  const toSpawn = []
  const toSkip = []

  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || typeof issue.number !== 'number') continue
    const ref = normalizeIssueRef(issue.number)
    if (sessionIssues.has(ref)) {
      toSkip.push({ number: issue.number, title: issue.title || '', reason: 'existing-session' })
      continue
    }
    toSpawn.push({ number: issue.number, title: issue.title || '' })
  }

  return { toSpawn, toSkip }
}

export function parseIssuesJson(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const number = typeof entry.number === 'number' ? entry.number : Number(entry.number)
        if (!Number.isFinite(number)) return null
        return { number, title: typeof entry.title === 'string' ? entry.title : '' }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function parseSessionsJson(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && typeof entry === 'object')
  } catch {
    return []
  }
}

export function recordEvents(log, events, now = new Date()) {
  const stamp = now.toISOString()
  const stamped = events.map((event) => ({ at: stamp, ...event }))
  return {
    ...log,
    lastRunAt: stamp,
    events: [...log.events, ...stamped],
  }
}
