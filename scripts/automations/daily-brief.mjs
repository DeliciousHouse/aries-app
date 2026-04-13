import path from 'node:path'
import {
  briefsDir,
  collectUncheckedBoxes,
  currentDateInfo,
  emitSummary,
  gitChangedFiles,
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

preflightOrExit('DAILY BRIEF', {
  binaries: ['git'],
  paths: [
    { label: 'repo root', path: repoRoot, type: 'dir' },
    { label: 'docs dir', path: path.join(repoRoot, 'docs'), type: 'dir' },
    { label: 'memory dir', path: path.join(repoRoot, 'memory'), type: 'dir' },
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}
const { date, stamp } = currentDateInfo()

const priorities = collectUncheckedBoxes(readText(path.join(repoRoot, 'PRIORITIES.md'))).slice(0, 5)
const roadmap = collectUncheckedBoxes(readText(path.join(repoRoot, 'ROADMAP.md'))).slice(0, 5)
const heartbeat = collectUncheckedBoxes(readText(path.join(repoRoot, 'HEARTBEAT.md'))).slice(0, 5)
const pendingActions = [...new Set([...roadmap, ...heartbeat])].slice(0, 8)
const overnightLog = run('git', ['log', '--since=24 hours ago', '--pretty=format:- %h %s (%cr)', '--max-count=8'])
const statusLines = gitChangedFiles(['status', '--short']).slice(0, 10).map((line) => `- ${line}`)
const memoryNote = readText(path.join(repoRoot, 'memory', `${date}.md`), '').trim()

const markdown = [
  `# Daily brief — ${date}`,
  '',
  `Generated ${stamp}.`,
  '',
  '## Priorities for today',
  ...(priorities.length ? priorities.map((item) => `- ${item}`) : ['- No open priority bullets found in PRIORITIES.md.']),
  '',
  '## Overnight activity',
  ...(overnightLog.ok && overnightLog.stdout.trim() ? overnightLog.stdout.split(/\r?\n/) : ['- No git activity recorded in the last 24 hours.']),
  '',
  '## Pending action items',
  ...(pendingActions.length ? pendingActions.map((item) => `- ${item}`) : ['- No open backlog items found in ROADMAP.md or HEARTBEAT.md.']),
  '',
  '## Needs attention',
  ...(statusLines.length ? statusLines : ['- Working tree currently clean.']),
  '',
  '## Overnight automation note',
  ...(memoryNote ? memoryNote.split(/\r?\n/).slice(-6) : ['- No overnight memory note found yet.']),
  '',
].join('\n')

const briefPath = path.join(briefsDir, `${date}-brief.md`)
if (!dryRun) {
  writeText(briefPath, markdown)
}

emitSummary([
  dryRun ? 'DAILY BRIEF DRY RUN' : 'DAILY BRIEF OK',
  `- file: docs/briefs/${date}-brief.md`,
  `- priorities: ${priorities.length}`,
  `- overnight items: ${overnightLog.ok && overnightLog.stdout.trim() ? overnightLog.stdout.split(/\r?\n/).length : 0}`,
  `- pending actions: ${pendingActions.length}`,
])
