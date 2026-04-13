import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  currentDateInfo,
  emitSummary,
  ensureDir,
  parseArgs,
  preflightOrExit,
  readText,
  repoRoot,
  run,
  writeText,
} from './lib/common.mjs'

const flags = parseArgs()
const dryRun = flags.has('--dry-run')
const preflightOnly = flags.has('--preflight')
const weeklyReviewEmail = process.env.ARIES_WEEKLY_REVIEW_EMAIL || ''
const weeklyReviewEmailScript = (process.env.ARIES_WEEKLY_REVIEW_EMAIL_SCRIPT || '').trim() || path.join(process.env.HOME || '', 'scripts', 'gmail-send.py')

preflightOrExit('WEEKLY REVIEW', {
  binaries: ['git', 'bash', 'openclaw', 'docker', ...(weeklyReviewEmail ? ['python3'] : [])],
  paths: [
    { label: 'board path', path: process.env.EXECUTION_TASKS_PATH || '/home/node/.openclaw/projects/shared/team/execution-tasks.json', type: 'file' },
    { label: 'reviews dir', path: path.join(repoRoot, 'memory', 'reviews'), type: 'dir' },
    ...(weeklyReviewEmail ? [{ label: 'email script', path: weeklyReviewEmailScript, type: 'file' }] : []),
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}
const LA_TIMEZONE = 'America/Los_Angeles'
const BOARD_PATH = process.env.EXECUTION_TASKS_PATH || '/home/node/.openclaw/projects/shared/team/execution-tasks.json'
const backlogPath = path.join(repoRoot, 'BACKLOG.md')
const reviewsDir = path.join(repoRoot, 'memory', 'reviews')

function zonedParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const map = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: LA_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday,
  }
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function zonedDateKey(value) {
  const { year, month, day } = zonedParts(value)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function formatDateLabel(value) {
  if (!value) return 'not set'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LA_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function startOfWeekMonday(now = new Date()) {
  const { year, month, day, weekday } = zonedParts(now)
  const current = new Date(Date.UTC(year, month - 1, day))
  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? current.getUTCDay()
  const diffToMonday = (weekdayIndex + 6) % 7
  const monday = new Date(current)
  monday.setUTCDate(monday.getUTCDate() - diffToMonday)
  return monday
}

function addDays(date, days) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function isWithinRange(value, start, endExclusive) {
  if (!value) return false
  const key = zonedDateKey(typeof value === 'number' ? new Date(value) : value)
  return key >= formatDateOnly(start) && key < formatDateOnly(endExclusive)
}

function daysBetween(value, now = Date.now()) {
  const time = typeof value === 'number' ? value : new Date(value).getTime()
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY
  return (now - time) / (24 * 60 * 60 * 1000)
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function trimList(items, max = 4) {
  return items.slice(0, max)
}

function loadDailyFiles(weekStart) {
  const files = []
  const missing = []
  const notableHeadings = []

  for (let index = 0; index < 5; index += 1) {
    const day = addDays(weekStart, index)
    const date = formatDateOnly(day)
    const filePath = path.join(repoRoot, 'memory', `${date}.md`)
    const exists = existsSync(filePath)
    files.push({ date, filePath, exists })
    if (!exists) {
      missing.push(date)
      continue
    }

    const text = readText(filePath, '')
    const headings = text
      .split(/\r?\n/)
      .filter((line) => /^##\s+/.test(line))
      .map((line) => line.replace(/^##\s+/, '').trim())
      .filter((heading) => heading && !/^Overnight self-improvement/i.test(heading))

    for (const heading of headings) {
      notableHeadings.push(`${date}: ${heading}`)
    }
  }

  return { files, missing, notableHeadings: trimList(notableHeadings, 4) }
}

function loadBoard() {
  try {
    const raw = JSON.parse(readFileSync(BOARD_PATH, 'utf8'))
    return Array.isArray(raw.tasks) ? raw.tasks : []
  } catch {
    return []
  }
}

function latestProgressAt(task) {
  const history = Array.isArray(task.statusHistory) ? task.statusHistory : []
  const latest = history.reduce((best, entry) => {
    if (!entry?.timestamp) return best
    if (!best) return entry.timestamp
    return new Date(entry.timestamp).getTime() > new Date(best).getTime() ? entry.timestamp : best
  }, null)
  return latest || task.updatedAt || task.createdAt || null
}

function shippedThisWeek(tasks, weekStart, weekEnd) {
  const shipped = []
  for (const task of tasks) {
    const history = Array.isArray(task.statusHistory) ? task.statusHistory : []
    const shippedEvent = history.find((entry) => entry?.toStatus === 'shipped' && isWithinRange(entry.timestamp, weekStart, weekEnd))
    const fallbackCurrent = task.status === 'shipped' && isWithinRange(task.updatedAt, weekStart, weekEnd)
    if (!shippedEvent && !fallbackCurrent) continue
    shipped.push({
      title: task.title || task.id,
      when: shippedEvent?.timestamp || task.updatedAt,
      task,
    })
  }

  return trimList(
    shipped.sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime()).map(({ title, task }) => {
      const scope = task.taskDomain || task.systemScope || 'workstream'
      return `${title} (${scope}; board shipped this week)`
    }),
    5,
  )
}

function collectInProgress(tasks) {
  const carryStatuses = new Set(['active', 'review', 'ready', 'follow-up', 'intake'])
  return trimList(
    tasks
      .filter((task) => carryStatuses.has(task.status))
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .map((task) => {
        const age = daysBetween(latestProgressAt(task))
        const overdueFlag = age > 7 ? ' [>1 week in progress]' : ''
        const blockerFlag = task.blocked ? ` Blocked: ${task.blockerReason || 'yes'}.` : ''
        return `${task.title || task.id} (${task.status}; expected ${task.dueDate ? formatDateLabel(task.dueDate) : 'not set'}).${blockerFlag}${overdueFlag}`
      }),
    5,
  )
}

function staleRecommendation(task) {
  if (task.blocked || task.status === 'follow-up') return 'reassign when dependency clears'
  if (task.status === 'intake' || task.status === 'ready') return 'complete or archive'
  return 'complete or rescope'
}

function collectStaleItems(tasks) {
  const staleTasks = tasks
    .filter((task) => task.status !== 'shipped')
    .filter((task) => daysBetween(latestProgressAt(task)) > 7)
    .sort((a, b) => new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime())

  return trimList(
    staleTasks.map((task) => `${task.title || task.id} (${task.status}; last touch ${formatDateLabel(latestProgressAt(task))}). Recommendation: ${staleRecommendation(task)}.`),
    5,
  )
}

function summarizeBoard(tasks, weekStart, weekEnd) {
  const statusCounts = tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1
    return acc
  }, {})
  const blockedCount = tasks.filter((task) => task.blocked).length

  return {
    shipped: shippedThisWeek(tasks, weekStart, weekEnd),
    inProgress: collectInProgress(tasks),
    stale: collectStaleItems(tasks),
    summary: `Board now shows ${tasks.length} task(s), ${blockedCount} blocked, and statuses ${Object.entries(statusCounts).map(([status, count]) => `${status}:${count}`).join(', ') || 'none'}.`,
  }
}

function summarizeGit() {
  const commitsResult = run('git', ['log', '--oneline', '--since=7 days ago'])
  const previousCommitsResult = run('git', ['log', '--oneline', '--since=14 days ago', '--until=7 days ago'])
  const filesChangedResult = run('bash', ['-lc', "git log --since='7 days ago' --name-only --pretty=format: | sed '/^$/d' | sort -u"])

  const commitLines = commitsResult.ok ? commitsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
  const previousCommitLines = previousCommitsResult.ok ? previousCommitsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
  const uniqueFiles = filesChangedResult.ok ? filesChangedResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []

  const notable = []
  for (const line of commitLines) {
    const subject = line.replace(/^[0-9a-f]+\s+/, '')
    if (/^Merge\b/i.test(subject)) continue
    if (/^chore\(deps\)/i.test(subject)) continue
    if (notable.some((entry) => entry.includes(subject))) continue
    notable.push(`${subject} (repo merge this week)`)
    if (notable.length >= 4) break
  }

  return {
    commitCount: commitLines.length,
    previousCommitCount: previousCommitLines.length,
    uniqueFileCount: uniqueFiles.length,
    notable,
  }
}

function loadCronJobs() {
  const cli = run('openclaw', ['cron', 'list', '--all', '--json'])
  if (cli.ok && cli.stdout.trim()) {
    try {
      const parsed = JSON.parse(cli.stdout)
      return Array.isArray(parsed.jobs) ? parsed.jobs : []
    } catch {}
  }

  const fallbackPath = path.join(process.env.HOME || '', '.openclaw', 'cron', 'jobs.json')
  try {
    const parsed = JSON.parse(readFileSync(fallbackPath, 'utf8'))
    return Array.isArray(parsed.jobs) ? parsed.jobs : Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function summarizeCron(jobs, weekStart) {
  if (!jobs.length) {
    return {
      healthyCount: 0,
      totalCount: 0,
      lines: ['- Cron state unavailable from current runtime surface.'],
    }
  }

  const healthyJobs = jobs.filter((job) => job?.state?.lastStatus === 'ok' && !job?.state?.consecutiveErrors)
  const unhealthyJobs = jobs
    .filter((job) => {
      const state = job.state || {}
      return state.lastStatus === 'error' || (state.consecutiveErrors || 0) > 0
    })
    .sort((a, b) => (b?.state?.consecutiveErrors || 0) - (a?.state?.consecutiveErrors || 0))

  const lines = [
    ...trimList(unhealthyJobs.map((job) => {
      const state = job.state || {}
      const when = state.lastRunAtMs ? formatDateLabel(state.lastRunAtMs) : 'unknown'
      return `- ${job.name}: ${state.lastErrorReason || state.lastStatus || 'degraded'} (${state.consecutiveErrors || 0} consecutive, last run ${when})`
    }), 5),
  ]

  if (!lines.length) {
    lines.push('- No cron failures surfaced in current live cron state.')
  }

  const recentIssues = unhealthyJobs.filter((job) => isWithinRange(job?.state?.lastRunAtMs, weekStart, addDays(weekStart, 7))).length
  lines.push(`- Overall: ${healthyJobs.length} of ${jobs.length} crons healthy; ${recentIssues} current issue(s) have a run in this review window.`)
  lines.push('- Unexpected-output checks are not exposed by current cron state, so only runtime success/error state is reported.')

  return {
    healthyCount: healthyJobs.length,
    totalCount: jobs.length,
    lines,
  }
}

function summarizeServices() {
  const compose = run('bash', ['-lc', 'docker compose ps --format json'], { cwd: repoRoot })
  if (!compose.ok || !compose.stdout.trim()) {
    return {
      summary: 'Service health unavailable from current docker compose surface.',
      healthyCount: 0,
      totalCount: 0,
    }
  }

  const entries = compose.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const healthyCount = entries.filter((entry) => entry.State === 'running' && (!entry.Health || entry.Health === 'healthy')).length
  return {
    summary: `Compose services: ${healthyCount}/${entries.length} running healthy.` + (entries.length ? ` ${entries.map((entry) => `${entry.Service}:${entry.State}${entry.Health ? `/${entry.Health}` : ''}`).join(', ')}.` : ''),
    healthyCount,
    totalCount: entries.length,
  }
}

function buildNextWeekFocus(prioritiesText, backlogMissing, dailyMissing) {
  const priorities = prioritiesText
    .split(/\r?\n/)
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, '').trim())

  const top = trimList(priorities, 3)
  const lines = top.map((item, index) => {
    if (index === 0) return `- ${item}`
    if (index === 1) return `- ${item}`
    return `- ${item}`
  })

  if (backlogMissing) {
    lines.push('- Decision: either create a canonical repo-root BACKLOG.md or keep treating PRIORITIES.md as the backlog surface.')
  }
  if (dailyMissing.length) {
    lines.push(`- Logging gap to fix: daily memory missing for ${dailyMissing.join(', ')}.`)
  }

  return trimList(lines, 5)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderListHtml(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`
}

const now = new Date()
const weekStart = startOfWeekMonday(now)
const weekEnd = addDays(weekStart, 7)
const weekOf = formatDateOnly(weekStart)
const { stamp } = currentDateInfo()
const daily = loadDailyFiles(weekStart)
const tasks = loadBoard()
const board = summarizeBoard(tasks, weekStart, weekEnd)
const git = summarizeGit()
const cron = summarizeCron(loadCronJobs(), weekStart)
const services = summarizeServices()
const prioritiesText = readText(path.join(repoRoot, 'PRIORITIES.md'), '')
const backlogExists = existsSync(backlogPath)

const shippedItems = trimList([
  ...board.shipped,
  ...git.notable,
], 6)

const staleItems = []
if (!backlogExists) {
  staleItems.push('BACKLOG.md is missing in the repo root, so backlog staleness cannot be verified from a canonical backlog file. Recommendation: create one or formally use PRIORITIES.md instead.')
}
staleItems.push(...board.stale)

const metricsLines = [
  `- Git velocity: ${git.commitCount} commits across ${git.uniqueFileCount} unique files in the last 7 days (${git.previousCommitCount} commits in the prior 7-day window).`,
  `- ${board.summary}`,
  `- Daily logs present this week: ${5 - daily.missing.length}/5.`,
  `- Cron health now: ${cron.healthyCount}/${cron.totalCount} healthy.`,
  `- Service health now: ${services.summary}`,
  `- Product-facing live metrics API not verified in this workspace, so this review reports operational live metrics only.`,
]

const nextWeekFocus = buildNextWeekFocus(prioritiesText, !backlogExists, daily.missing)

const markdownSections = [
  `# Weekly Review - Week of ${weekOf}`,
  '',
  `Generated ${stamp}.`,
  '',
  '## Shipped This Week',
  ...(shippedItems.length ? shippedItems.map((item) => `- ${item}`) : ['- No shipped work verified from current board and git truth.']),
  '',
  '## In Progress (Carrying Over)',
  ...(board.inProgress.length ? board.inProgress.map((item) => `- ${item}`) : ['- No carry-over items visible on the current board.']),
  '',
  '## Stale Items (Action Required)',
  ...(staleItems.length ? staleItems.map((item) => `- ${item}`) : ['- No stale items identified from current backlog/board truth.']),
  '',
  '## Cron Health',
  ...cron.lines,
  '',
  '## Metrics Snapshot',
  ...metricsLines,
  '',
  '## Next Week Focus',
  ...(nextWeekFocus.length ? nextWeekFocus : ['- No next-week focus extracted from current priority truth.']),
  '',
].join('\n')

let markdown = markdownSections
if (countWords(markdown) > 800) {
  markdown = [
    `# Weekly Review - Week of ${weekOf}`,
    '',
    `Generated ${stamp}.`,
    '',
    '## Shipped This Week',
    ...(trimList(shippedItems, 4).length ? trimList(shippedItems, 4).map((item) => `- ${item}`) : ['- No shipped work verified from current board and git truth.']),
    '',
    '## In Progress (Carrying Over)',
    ...(trimList(board.inProgress, 4).length ? trimList(board.inProgress, 4).map((item) => `- ${item}`) : ['- No carry-over items visible on the current board.']),
    '',
    '## Stale Items (Action Required)',
    ...(trimList(staleItems, 4).length ? trimList(staleItems, 4).map((item) => `- ${item}`) : ['- No stale items identified from current backlog/board truth.']),
    '',
    '## Cron Health',
    ...trimList(cron.lines, 4),
    '',
    '## Metrics Snapshot',
    ...trimList(metricsLines, 4),
    '',
    '## Next Week Focus',
    ...trimList(nextWeekFocus, 4),
    '',
  ].join('\n')
}

const html = [
  '<html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111">',
  `<h1>Weekly Review - Week of ${escapeHtml(weekOf)}</h1>`,
  `<p>Generated ${escapeHtml(stamp)}.</p>`,
  '<h2>Shipped This Week</h2>',
  renderListHtml(shippedItems.length ? shippedItems : ['No shipped work verified from current board and git truth.']),
  '<h2>In Progress (Carrying Over)</h2>',
  renderListHtml(board.inProgress.length ? board.inProgress : ['No carry-over items visible on the current board.']),
  '<h2>Stale Items (Action Required)</h2>',
  renderListHtml(staleItems.length ? staleItems : ['No stale items identified from current backlog/board truth.']),
  '<h2>Cron Health</h2>',
  renderListHtml(cron.lines),
  '<h2>Metrics Snapshot</h2>',
  renderListHtml(metricsLines),
  '<h2>Next Week Focus</h2>',
  renderListHtml(nextWeekFocus.length ? nextWeekFocus : ['No next-week focus extracted from current priority truth.']),
  '</body></html>',
].join('')

const reviewBase = path.join(reviewsDir, `week-of-${weekOf}`)
const markdownPath = `${reviewBase}.md`
const htmlPath = `${reviewBase}.html`

if (!dryRun) {
  ensureDir(reviewsDir)
  writeText(markdownPath, markdown)
  writeText(htmlPath, html)
}

let emailStatus = 'skipped (missing recipient or mailer script)'
if (weeklyReviewEmail && existsSync(weeklyReviewEmailScript)) {
  const subject = `Weekly Review - Week of ${weekOf}`
  const emailResult = run('python3', [weeklyReviewEmailScript, '--to', weeklyReviewEmail, '--subject', subject, '--body', html, '--html'])
  emailStatus = emailResult.ok ? `sent to ${weeklyReviewEmail}` : `failed (${(emailResult.stderr || emailResult.stdout || '').split(/\r?\n/).find(Boolean) || `exit ${emailResult.code}`})`
}

emitSummary([
  dryRun ? 'WEEKLY REVIEW DRY RUN' : 'WEEKLY REVIEW OK',
  `- week_of: ${weekOf}`,
  `- review_md: memory/reviews/week-of-${weekOf}.md`,
  `- review_html: memory/reviews/week-of-${weekOf}.html`,
  `- daily_files: ${5 - daily.missing.length}/5 present`,
  `- crons_healthy: ${cron.healthyCount}/${cron.totalCount}`,
  `- services_healthy: ${services.healthyCount}/${services.totalCount}`,
  `- email: ${emailStatus}`,
])
