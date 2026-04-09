import path from 'node:path'
import process from 'node:process'
import { emitSummary, ensureDir, readText, repoRoot, run, writeText } from './common.mjs'

export const feedbackLogPath = path.join(repoRoot, 'data', 'feedback-processing-log.json')
export const defaultFeedbackRepo = process.env.ARIES_GITHUB_REPO || 'DeliciousHouse/aries-app'

function nowIso() {
  return new Date().toISOString()
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function issueLabels(issue) {
  return (issue.labels || []).map((label) => String(label.name || label).toLowerCase())
}

function summarizeReason(type, source, detail) {
  return `${type} via ${source}${detail ? `: ${detail}` : ''}`
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'issue'
}

export function createEmptyFeedbackLog(repo = defaultFeedbackRepo) {
  return {
    version: 1,
    repo,
    lastSyncAt: null,
    lastDailySummaryAt: null,
    items: [],
  }
}

export function loadFeedbackLog(repo = defaultFeedbackRepo) {
  const fallback = createEmptyFeedbackLog(repo)
  const raw = readText(feedbackLogPath, '')
  if (!raw.trim()) return fallback
  const parsed = safeJsonParse(raw, fallback)
  if (!parsed || typeof parsed !== 'object') return fallback
  parsed.version ||= 1
  parsed.repo ||= repo
  parsed.items = Array.isArray(parsed.items) ? parsed.items : []
  return parsed
}

export function saveFeedbackLog(log) {
  ensureDir(path.dirname(feedbackLogPath))
  writeText(feedbackLogPath, `${JSON.stringify(log, null, 2)}\n`)
}

export function classifyIssue(issue) {
  const labels = issueLabels(issue)
  const body = String(issue.body || '')
  const haystack = `${issue.title || ''}\n${body}`.toLowerCase()

  if (labels.some((label) => ['bug', 'regression', 'incident', 'outage'].includes(label))) {
    return {
      type: 'bug',
      source: 'label',
      reason: summarizeReason('bug', 'label', labels.find((label) => ['bug', 'regression', 'incident', 'outage'].includes(label))),
    }
  }

  if (labels.some((label) => ['enhancement', 'feature', 'request', 'idea'].includes(label))) {
    return {
      type: 'feature',
      source: 'label',
      reason: summarizeReason('feature', 'label', labels.find((label) => ['enhancement', 'feature', 'request', 'idea'].includes(label))),
    }
  }

  const bugSignals = [
    'bug',
    'broken',
    'error',
    'regression',
    'fails',
    'failing',
    'crash',
    'unexpected',
    'actual',
    'expected',
    'steps to reproduce',
    'cannot',
    'can not',
    'does not work',
  ].filter((signal) => haystack.includes(signal))

  const featureSignals = [
    'feature request',
    'enhancement',
    'would like',
    'could we',
    'please add',
    'it would be great',
    'proposal',
    'roadmap',
    'support for',
    'add a way to',
  ].filter((signal) => haystack.includes(signal))

  if (bugSignals.length > featureSignals.length) {
    return {
      type: 'bug',
      source: 'heuristic',
      reason: summarizeReason('bug', 'heuristic', bugSignals.slice(0, 3).join(', ')),
    }
  }

  return {
    type: 'feature',
    source: featureSignals.length ? 'heuristic' : 'fallback',
    reason: summarizeReason('feature', featureSignals.length ? 'heuristic' : 'fallback', featureSignals.slice(0, 3).join(', ')),
  }
}

function compareIso(a, b) {
  return (Date.parse(a || '') || 0) - (Date.parse(b || '') || 0)
}

function ensureHistory(item) {
  item.history = Array.isArray(item.history) ? item.history : []
  return item.history
}

function createIssueRecord(issue, repo) {
  const classification = classifyIssue(issue)
  const now = nowIso()
  return {
    repo,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body || '',
    url: issue.url,
    labels: issueLabels(issue),
    author: issue.author?.login || issue.author?.name || 'unknown',
    classification,
    status: 'pending',
    severity: null,
    rootCause: null,
    branch: null,
    prUrl: null,
    stagingUrl: null,
    validationBefore: null,
    validationAfter: null,
    effortHours: null,
    impactScore: null,
    alignmentScore: null,
    approvalDecision: null,
    approvalReason: null,
    lastSeenAt: now,
    lastIssueUpdatedAt: issue.updatedAt || issue.createdAt || now,
    lastProcessedAt: null,
    summaryPending: false,
    criticalAlertSentAt: null,
    closedAt: null,
    history: [
      {
        at: now,
        event: 'discovered',
        details: classification.reason,
      },
    ],
  }
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(output[key], value)
      continue
    }
    output[key] = value
  }
  return output
}

export function syncFeedbackIssues({ repo = defaultFeedbackRepo, limit = 100, dryRun = false } = {}) {
  const log = loadFeedbackLog(repo)
  const result = run('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,title,body,labels,createdAt,updatedAt,url,author',
  ])

  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'gh issue list failed')
  }

  const issues = safeJsonParse(result.stdout, [])
  const seen = new Set()
  const nextItems = []
  const existingByNumber = new Map(log.items.map((item) => [item.issueNumber, item]))
  const stats = { scanned: issues.length, new: 0, requeued: 0, unchanged: 0, closed: 0 }
  const syncAt = nowIso()

  for (const issue of issues) {
    seen.add(issue.number)
    const existing = existingByNumber.get(issue.number)
    if (!existing) {
      nextItems.push(createIssueRecord(issue, repo))
      stats.new += 1
      continue
    }

    const classification = classifyIssue(issue)
    const updated = {
      ...existing,
      title: issue.title,
      body: issue.body || '',
      url: issue.url,
      labels: issueLabels(issue),
      author: issue.author?.login || issue.author?.name || existing.author || 'unknown',
      classification,
      lastSeenAt: syncAt,
      lastIssueUpdatedAt: issue.updatedAt || issue.createdAt || existing.lastIssueUpdatedAt,
    }

    ensureHistory(updated)
    if (compareIso(updated.lastIssueUpdatedAt, existing.lastIssueUpdatedAt) > 0 && existing.status !== 'pending') {
      updated.status = 'pending'
      updated.summaryPending = false
      updated.history.push({ at: syncAt, event: 'issue-updated-requeued', details: classification.reason })
      stats.requeued += 1
    } else {
      stats.unchanged += 1
    }

    nextItems.push(updated)
  }

  for (const existing of log.items) {
    if (seen.has(existing.issueNumber)) continue
    const updated = { ...existing }
    ensureHistory(updated)
    if (updated.status !== 'closed') {
      updated.status = 'closed'
      updated.closedAt ||= syncAt
      updated.history.push({ at: syncAt, event: 'closed-upstream', details: 'Issue is no longer open in GitHub.' })
      stats.closed += 1
    }
    nextItems.push(updated)
  }

  nextItems.sort((a, b) => a.issueNumber - b.issueNumber)
  log.repo = repo
  log.lastSyncAt = syncAt
  log.items = nextItems

  if (!dryRun) saveFeedbackLog(log)

  return {
    log,
    stats,
    pending: nextItems.filter((item) => item.status === 'pending'),
  }
}

export function getPendingItems({ repo = defaultFeedbackRepo, type = null } = {}) {
  const log = loadFeedbackLog(repo)
  return log.items.filter((item) => item.status === 'pending' && (!type || item.classification?.type === type))
}

export function markFeedbackItem({ number, patch, repo = defaultFeedbackRepo, dryRun = false } = {}) {
  const log = loadFeedbackLog(repo)
  const item = log.items.find((entry) => entry.issueNumber === Number(number))
  if (!item) {
    throw new Error(`Issue #${number} is not present in ${feedbackLogPath}`)
  }

  const patchCopy = safeJsonParse(JSON.stringify(patch || {}), {})
  const historyEvent = patchCopy.historyEvent || patchCopy.status || 'updated'
  const historyDetails = patchCopy.historyDetails || null
  delete patchCopy.historyEvent
  delete patchCopy.historyDetails

  const merged = deepMerge(item, patchCopy)
  const stamp = nowIso()
  ensureHistory(merged)
  merged.history.push({ at: stamp, event: historyEvent, details: historyDetails })
  merged.lastProcessedAt = stamp

  if (merged.status === 'closed' || merged.status === 'rejected') {
    merged.closedAt ||= stamp
  }

  Object.assign(item, merged)
  if (!dryRun) saveFeedbackLog(log)
  return { log, item }
}

function formatIssueSummary(item) {
  const prefix = item.classification?.type === 'bug' ? 'BUG' : 'FEATURE'
  if (item.classification?.type === 'bug') {
    return `- ${prefix} #${item.issueNumber} [${item.severity || 'unrated'}] ${item.status}; branch: ${item.branch || 'none'}; staging: ${item.stagingUrl || 'none'}`
  }

  if (item.approvalDecision === 'rejected') {
    return `- ${prefix} #${item.issueNumber} rejected; reason: ${item.approvalReason || 'none recorded'}`
  }

  return `- ${prefix} #${item.issueNumber} ${item.approvalDecision || item.status}; effort: ${item.effortHours ?? 'n/a'}h; impact: ${item.impactScore ?? 'n/a'}; alignment: ${item.alignmentScore ?? 'n/a'}; staging: ${item.stagingUrl || 'none'}`
}

export function buildDailySummary({ repo = defaultFeedbackRepo, log: providedLog = null, markSent = false, dryRun = false } = {}) {
  const log = providedLog || loadFeedbackLog(repo)
  const items = log.items.filter((item) => item.summaryPending && item.severity !== 'critical')
  const lines = [
    `status: ${items.length ? 'success' : 'no-op'}`,
    `repo: ${log.repo}`,
    `items: ${items.length}`,
    'summary:',
  ]

  if (!items.length) {
    lines.push('- none')
    lines.push('next_step: none')
    return { text: lines.join('\n'), itemNumbers: [] }
  }

  items
    .sort((a, b) => compareIso(a.lastProcessedAt, b.lastProcessedAt))
    .forEach((item) => lines.push(formatIssueSummary(item)))

  lines.push('next_step: none')

  if (markSent && !dryRun) {
    const stamp = nowIso()
    for (const item of items) {
      item.summaryPending = false
      ensureHistory(item).push({ at: stamp, event: 'daily-summary-sent', details: null })
    }
    log.lastDailySummaryAt = stamp
    saveFeedbackLog(log)
  }

  return {
    text: lines.join('\n'),
    itemNumbers: items.map((item) => item.issueNumber),
  }
}

export function printJson(value) {
  emitSummary(JSON.stringify(value, null, 2))
}
