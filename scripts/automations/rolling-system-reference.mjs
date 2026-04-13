import path from 'node:path'
import { automationJobs } from './manifest.mjs'
import {
  currentDateInfo,
  emitSummary,
  gitChangedFiles,
  listFiles,
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

preflightOrExit('SYSTEM REFERENCE', {
  binaries: ['git'],
  paths: [
    { label: 'repo root', path: repoRoot, type: 'dir' },
    { label: 'docs dir', path: path.join(repoRoot, 'docs'), type: 'dir' },
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}
const { date, stamp } = currentDateInfo()

const packageJson = JSON.parse(readText(path.join(repoRoot, 'package.json'), '{}'))
const todayChanges = run('git', ['log', '--since=midnight', '--name-only', '--pretty=format:commit %h %s'])
const changedFiles = todayChanges.ok
  ? todayChanges.stdout
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('commit '))
      .filter((line, index, lines) => lines.indexOf(line) === index)
      .slice(0, 30)
  : []

const moduleInventory = [
  ['app/', listFiles(path.join(repoRoot, 'app')).length],
  ['backend/', listFiles(path.join(repoRoot, 'backend')).length],
  ['components/', listFiles(path.join(repoRoot, 'components')).length],
  ['hooks/', listFiles(path.join(repoRoot, 'hooks')).length],
  ['lib/', listFiles(path.join(repoRoot, 'lib')).length],
  ['scripts/', listFiles(path.join(repoRoot, 'scripts')).length],
  ['skills/', listFiles(path.join(repoRoot, 'skills')).length],
  ['workflows/', listFiles(path.join(repoRoot, 'workflows')).length],
]

const knownIssues = [
  'Cron registration is prepared but not auto-enabled until backup remote/delivery targets are confirmed.',
  'Daily brief and system reference depend on local markdown/task hygiene; the better the source docs, the sharper the briefs.',
  'Mission Control standalone app is still a shell around runtime overview data and awaits richer live API adapters for actions/transcripts.',
]

const markdown = [
  '# Aries System Reference',
  '',
  `Last refreshed ${stamp}.`,
  '',
  '## What changed today',
  ...(changedFiles.length ? changedFiles.map((file) => `- ${file}`) : ['- No git-tracked file changes detected since local midnight.']),
  '',
  '## Current architecture overview',
  '- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.',
  '- Backend domain logic lives under backend/* and routes long-running execution through OpenClaw Gateway rather than direct browser workflow exposure.',
  '- Local runtime state and typed adapters live across lib/*, hooks/*, specs/*, and workflows/* to preserve contract boundaries.',
  '- Standalone Mission Control deploys as a separate image and reads /api/runtime/overview from its local runtime server.',
  '',
  '## Module inventory',
  ...moduleInventory.map(([label, count]) => `- ${label} ${count} files`),
  '',
  '## Active cron jobs',
  ...automationJobs.map((job) => `- ${job.name} — ${job.cron} ${job.tz} — ${job.purpose}`),
  '',
  '## Runtime scripts',
  ...Object.entries(packageJson.scripts || {}).map(([name, value]) => `- ${name}: ${value}`),
  '',
  '## Known issues',
  ...knownIssues.map((item) => `- ${item}`),
  '',
  `## Working tree snapshot`,
  ...(gitChangedFiles(['status', '--short']).length
    ? gitChangedFiles(['status', '--short']).slice(0, 20).map((line) => `- ${line}`)
    : ['- Working tree clean at refresh time.']),
  '',
  `## Reference date`,
  `- ${date}`,
  '',
].join('\n')

if (!dryRun) {
  writeText(path.join(repoRoot, 'docs', 'SYSTEM-REFERENCE.md'), markdown)
}

emitSummary([
  dryRun ? 'SYSTEM REFERENCE DRY RUN' : 'SYSTEM REFERENCE OK',
  '- file: docs/SYSTEM-REFERENCE.md',
  `- changed files captured: ${changedFiles.length}`,
  `- cron jobs documented: ${automationJobs.length}`,
])
