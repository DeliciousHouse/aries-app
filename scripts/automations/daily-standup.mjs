import path from 'node:path'
import process from 'node:process'
import { existsSync, readFileSync } from 'node:fs'
import {
  currentDateInfo,
  emitSummary,
  parseArgs,
  run,
  writeText,
} from './lib/common.mjs'

const flags = parseArgs()
const dryRun = flags.has('--dry-run')
const MISSION_CONTROL_ROOT = process.env.MISSION_CONTROL_ROOT || '/home/node/.openclaw/projects/mission_control'
const FALLBACK_BOARD_PATH = process.env.EXECUTION_TASKS_PATH || '/home/node/.openclaw/projects/shared/team/execution-tasks.json'
const SHARED_TEAMS_ROOT = process.env.ARIES_SHARED_TEAMS_ROOT || '/home/node/.openclaw/projects/shared/teams'
const SHARED_MEETINGS_DIR = path.join(SHARED_TEAMS_ROOT, 'meetings')
const SHARED_STANDUPS_DIR = path.join(SHARED_TEAMS_ROOT, 'standups')

async function loadProjectBoardPayload() {
  const modulePath = path.join(MISSION_CONTROL_ROOT, 'server', 'lib', 'project-board.mjs')
  if (existsSync(modulePath)) {
    const module = await import(`file://${modulePath}`)
    if (typeof module.loadProjectBoardPayload === 'function') {
      return module.loadProjectBoardPayload()
    }
  }

  const raw = JSON.parse(readFileSync(FALLBACK_BOARD_PATH, 'utf8'))
  return {
    ...raw,
    source: {
      path: FALLBACK_BOARD_PATH,
      mode: 'fallback_file',
    },
  }
}

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 }
const statusRank = { active: 0, review: 1, ready: 2, 'follow-up': 3, intake: 4, shipped: 5 }

function rankTask(task) {
  return [statusRank[task.status] ?? 9, priorityRank[task.priority] ?? 9, task.blocked ? 0 : 1, task.title || task.id || '']
}

function compareTasks(left, right) {
  const a = rankTask(left)
  const b = rankTask(right)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

function chooseTopTask(tasks) {
  if (!tasks.length) return null
  return [...tasks].sort(compareTasks)[0]
}

function countByStatus(tasks) {
  return tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1
    return acc
  }, {})
}

function formatCounts(counts) {
  const ordered = ['active', 'review', 'ready', 'follow-up', 'intake', 'shipped']
  const lines = ordered.filter((status) => counts[status]).map((status) => `${status} ${counts[status]}`)
  return lines.length ? lines.join(', ') : 'no tracked items'
}

function bulletize(items, fallback = 'None.') {
  return items.length ? items.map((item) => `- ${item}`) : [`- ${fallback}`]
}

function summarizeVerify(result) {
  if (result.ok) return 'passed'
  const combined = `${result.stdout}\n${result.stderr}`
  const line = combined
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean)
  return line || `failed with exit ${result.code}`
}

function laneReport({ chiefId, chiefAgentId, title, tasks, standupId, extraCurrent = [], extraBlockers = [], reportStatus = 'complete' }) {
  const activeTasks = tasks.filter((task) => task.status !== 'shipped')
  const topTask = chooseTopTask(activeTasks.length ? activeTasks : tasks)
  const blockedTasks = tasks.filter((task) => task.blocked)
  const counts = countByStatus(tasks)

  const report = {
    sourceType: 'standup',
    reportId: `${standupId}:${chiefId}`,
    standupId,
    standupTitle: `Daily Standup — ${standupId.replace('daily-standup-', '')}`,
    chiefId,
    chiefAgentId,
    reportStatus,
    activeTaskId: topTask?.id || null,
    currentStatus: topTask?.status || 'unknown',
    boardSummary: {
      trackedItems: tasks.length,
      statusCounts: counts,
    },
    blockers: [
      ...blockedTasks.map((task) => ({ taskId: task.id, status: task.status, priority: task.priority || 'unknown' })),
      ...extraBlockers.map((summary) => ({ summary })),
    ],
    humanDependencies: [],
    needsJarvisRouting: blockedTasks.length
      ? [
          {
            summary: `Reconcile blocked ${chiefId} lane items before claiming closure.`,
            requestedAction: 'Review blocked lane items and stale board status.',
            nextAction: 'Update or reroute the blocked lane item.',
          },
        ]
      : [],
    notes: [
      topTask ? `Board truth: top lane task is ${topTask.id} in ${topTask.status}.` : 'No current lane task is visible on the board.',
      `Lane snapshot: ${tasks.length} tracked item(s), ${formatCounts(counts)}.`,
      ...extraCurrent,
    ],
  }

  return {
    ...report,
    title,
    topTask,
    markdown: [
      `### ${title}`,
      `- chief_id: ${chiefId}`,
      `- chief_agent_id: ${chiefAgentId}`,
      `- report_status: ${reportStatus}`,
      `- Active task: ${topTask ? `\`${topTask.id}\`` : 'none visible on board'}`,
      `- Current status: ${topTask?.status || 'unknown'}`,
      '',
      '#### Current Status',
      ...bulletize(report.notes.filter(Boolean), 'No current status notes.'),
      '',
      '#### Blockers',
      ...bulletize(report.blockers.map((item) => item.summary || `Blocked board item: \`${item.taskId}\` (${item.status}, ${item.priority}).`), 'No blockers are flagged in board truth for this lane.'),
      '',
      '#### Human Dependencies',
      ...bulletize([], 'No explicit human dependency is encoded in this automation beyond what board truth already shows.'),
      '',
      '#### Needs Jarvis Routing',
      ...bulletize(report.needsJarvisRouting.map((item) => item.summary), 'No Jarvis routing request is required from current board truth.'),
      '',
    ].join('\n'),
  }
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

const { date } = currentDateInfo()
const standupId = `daily-standup-${date}`
const standupTitle = `Daily Standup — ${date}`
const sharedTranscriptPath = path.join(SHARED_MEETINGS_DIR, `${date}-daily-standup.md`)
const sharedStandupDir = path.join(SHARED_STANDUPS_DIR, date)

const board = await loadProjectBoardPayload()
const tasks = Array.isArray(board.tasks) ? board.tasks : []
const workspaceVerify = run('npm', ['run', 'workspace:verify'], { timeout: 120000 })
const workspaceVerifyStatus = summarizeVerify(workspaceVerify)

const forgeTasks = tasks.filter((task) => ['frontend', 'backend'].includes(task.taskDomain))
const signalTasks = tasks.filter((task) => task.taskDomain === 'runtime-automation')
const ledgerTasks = tasks.filter((task) => task.taskDomain === 'operations-knowledge')

const forge = laneReport({
  chiefId: 'forge',
  chiefAgentId: 'delivery-chief',
  title: 'Forge — Engineering Delivery',
  tasks: forgeTasks,
  standupId,
  extraCurrent: [workspaceVerify.ok ? `Fresh workspace verification passed on ${date}.` : `Workspace verification is unavailable right now: ${workspaceVerifyStatus}.`],
  extraBlockers: !workspaceVerify.ok ? [`Workspace verification failed: ${workspaceVerifyStatus}.`] : [],
})

const signal = laneReport({
  chiefId: 'signal',
  chiefAgentId: 'runtime-chief',
  title: 'Signal — Runtime & Automation',
  tasks: signalTasks,
  standupId,
  reportStatus: 'partial',
  extraCurrent: [
    'Live runtime truth is not re-verified by this board-based standup automation, so runtime detail remains limited to board truth.',
    workspaceVerify.ok ? `Fresh workspace verification passed on ${date}.` : `Workspace verification is unavailable right now: ${workspaceVerifyStatus}.`,
  ],
  extraBlockers: [
    'Current live scheduler and runtime visibility are not sampled in this automation run, so missed-run validation remains incomplete.',
    ...(!workspaceVerify.ok ? [`Workspace verification failed: ${workspaceVerifyStatus}.`] : []),
  ],
})

const ledger = laneReport({
  chiefId: 'ledger',
  chiefAgentId: 'knowledge-chief',
  title: 'Ledger — Operations & Knowledge',
  tasks: ledgerTasks,
  standupId,
  extraCurrent: [workspaceVerify.ok ? `Fresh workspace verification passed on ${date}.` : `Workspace verification is unavailable right now: ${workspaceVerifyStatus}.`],
  extraBlockers: !workspaceVerify.ok ? [`Workspace verification failed: ${workspaceVerifyStatus}.`] : [],
})

function blockedLaneTasks(items, laneLabel) {
  return items.filter((task) => task.blocked).map((task) => `${laneLabel} lane blocked: \`${task.id}\` remains blocked on the board.`)
}

const primaryBlockers = [
  ...blockedLaneTasks(forgeTasks, 'Delivery'),
  ...blockedLaneTasks(signalTasks, 'Runtime'),
  ...blockedLaneTasks(ledgerTasks, 'Operations'),
  ...(!workspaceVerify.ok ? [`Workspace verification failed: ${workspaceVerifyStatus}.`] : []),
]

const automationCaveats = [
  'Runtime lane remains partial because this automation does not claim live scheduler truth without a direct runtime probe.',
]

const overallStatus = primaryBlockers.length ? 'partial' : 'complete'
const transcript = [
  '---',
  `standup_id: ${standupId}`,
  `title: ${standupTitle}`,
  `date: ${date}`,
  `generated_at: ${new Date().toISOString()}`,
  `status: ${overallStatus}`,
  'delivery: cron:auto',
  `board_path: ${board.source?.path || FALLBACK_BOARD_PATH}`,
  '---',
  '',
  `# ${standupTitle}`,
  '',
  '## Top Summary',
  `- Overall status: ${overallStatus}.`,
  `- Workspace verification: ${workspaceVerify.ok ? 'passed' : `failed (${workspaceVerifyStatus})`}.`,
  forge.topTask ? `- Forge lane focus: \`${forge.topTask.id}\` is ${forge.topTask.status}.` : '- Forge lane focus: no tracked task visible.',
  signal.topTask ? `- Signal lane focus: \`${signal.topTask.id}\` is ${signal.topTask.status}, but live runtime truth was not re-verified in this automation.` : '- Signal lane focus: no tracked task visible.',
  ledger.topTask ? `- Ledger lane focus: \`${ledger.topTask.id}\` is ${ledger.topTask.status}.` : '- Ledger lane focus: no tracked task visible.',
  '',
  '## Standup Health',
  `- overall_status: ${overallStatus}`,
  '- responding_chiefs: 3/3 (board-derived)',
  `- workspace_verify: ${workspaceVerify.ok ? 'passed' : 'failed'}`,
  '- primary_blockers:',
  ...bulletize(primaryBlockers, 'No primary blockers.'),
  '- automation_caveats:',
  ...bulletize(automationCaveats),
  '',
  '## Chief Reports',
  '',
  forge.markdown,
  signal.markdown,
  ledger.markdown,
  '## Delivery Notes',
  `- Standup transcript archived at \`${sharedTranscriptPath}\`.`,
  `- Structured chief reports archived at \`${sharedStandupDir}\`.`,
  '- This cron run is board-derived and truthful about unavailable live runtime detail.',
  '',
].join('\n')

if (!dryRun) {
  writeText(sharedTranscriptPath, transcript)
  writeJson(path.join(sharedStandupDir, 'forge-report.json'), forge)
  writeJson(path.join(sharedStandupDir, 'signal-report.json'), signal)
  writeJson(path.join(sharedStandupDir, 'ledger-report.json'), ledger)
}

emitSummary([
  dryRun ? 'DAILY STANDUP DRY RUN' : overallStatus === 'complete' ? 'DAILY STANDUP OK' : 'DAILY STANDUP PARTIAL',
  `- transcript: ${sharedTranscriptPath}`,
  `- reports: ${sharedStandupDir}`,
  `- workspace verify: ${workspaceVerify.ok ? 'passed' : `failed (${workspaceVerifyStatus})`}`,
  `- forge: ${forge.topTask ? `${forge.topTask.status} / ${forge.topTask.id}` : 'no visible task'}`,
  `- signal: ${signal.topTask ? `${signal.topTask.status} / ${signal.topTask.id}` : 'no visible task'}`,
  `- ledger: ${ledger.topTask ? `${ledger.topTask.status} / ${ledger.topTask.id}` : 'no visible task'}`,
])
