import process from 'node:process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  currentDateInfo,
  emitSummary,
  preflightOrExit,
  repoRoot,
} from './lib/common.mjs'

const preflightOnly = process.argv.includes('--preflight')
const boardPath = process.env.EXECUTION_TASKS_PATH || '/home/node/.openclaw/projects/shared/team/execution-tasks.json'
const feedbackPath = path.join(repoRoot, 'data', 'feedback-processing-log.json')
const buildLogPath = path.join(repoRoot, 'data', 'nightly-build-log.json')

preflightOrExit('OVERNIGHT SELF-IMPROVE', {
  paths: [
    { label: 'board path', path: boardPath, type: 'file' },
    { label: 'feedback log', path: feedbackPath, type: 'file' },
    { label: 'nightly build log', path: buildLogPath, type: 'file' },
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}
const { date } = currentDateInfo()

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function listRecentBuilds() {
  const log = readJson(buildLogPath, { builds: [] })
  const builds = Array.isArray(log.builds) ? log.builds : []
  return builds.slice(-5).reverse()
}

function listFeedbackBugs() {
  const data = readJson(feedbackPath, { items: [] })
  const items = Array.isArray(data.items) ? data.items : []
  return items
    .filter((item) => item && item.type === 'bug' && item.summaryPending !== false)
    .slice(0, 5)
}

function listReadyBoardItems() {
  const data = readJson(boardPath, { tasks: [] })
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 }

  return tasks
    .filter((task) => task && task.status === 'ready' && !task.blocked)
    .sort((a, b) => {
      const pa = priorityRank[a.priority] ?? 9
      const pb = priorityRank[b.priority] ?? 9
      if (pa !== pb) return pa - pb
      return new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime()
    })
    .slice(0, 5)
}

const recentBuilds = listRecentBuilds()
const feedbackBugs = listFeedbackBugs()
const readyItems = listReadyBoardItems()

emitSummary([
  'NIGHTLY BUILD CONTEXT',
  `- date: ${date}`,
  `- build_log: ${existsSync(buildLogPath) ? 'present' : 'missing'} (${path.relative(repoRoot, buildLogPath)})`,
  `- recent_builds: ${recentBuilds.length}`,
  ...(recentBuilds.length
    ? recentBuilds.map((entry, index) => `  ${index + 1}. ${entry.date || 'unknown'} :: ${entry.title || 'untitled'} :: ${entry.status || 'unknown'}`)
    : ['  none logged yet']),
  `- feedback_bug_candidates: ${feedbackBugs.length}`,
  ...(feedbackBugs.length
    ? feedbackBugs.map((item) => `  - #${item.number || '?'} ${item.title || 'untitled bug'}`)
    : ['  - none']),
  `- ready_board_candidates: ${readyItems.length}`,
  ...(readyItems.length
    ? readyItems.map((task) => `  - ${task.id} :: ${task.title} (${task.priority || 'unknown'})`)
    : ['  - none']),
])
