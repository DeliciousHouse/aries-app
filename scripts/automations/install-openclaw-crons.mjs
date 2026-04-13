import { execFileSync } from 'node:child_process'
import { automationJobs } from './manifest.mjs'
import { emitSummary, parseArgs, repoRoot } from './lib/common.mjs'

const flags = parseArgs()
const apply = flags.has('--apply')
const deliver = flags.has('--announce')
const agent = process.env.ARIES_CRON_AGENT || 'default'
const channel = process.env.ARIES_CRON_CHANNEL || ''
const target = process.env.ARIES_CRON_TARGET || ''

function buildPrompt(job) {
  const MAX_PROMPT_LINES = 20
  const contextLines = [
    `- Project: ${repoRoot}`,
    ...(Array.isArray(job.context) ? job.context : []),
  ]
  const promptLines = [
    `Read and follow: ${repoRoot}/skills/${job.skill}/SKILL.md`,
    '',
    'Context:',
    ...contextLines,
  ]

  if (promptLines.length > MAX_PROMPT_LINES) {
    throw new Error(
      `Prompt for cron job "${job.name}" exceeds ${MAX_PROMPT_LINES} lines (${promptLines.length}). ` +
        'Reduce job.context so the generated prompt complies with skills/_templates/cron-rules.md.'
    )
  }

  return promptLines.join('\n')
}

function listExistingJobs() {
  const raw = execFileSync('openclaw', ['cron', 'list', '--all', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  const parsed = JSON.parse(raw)
  return new Map((parsed.jobs || []).map((job) => [job.name, job]))
}

function buildCommand(job, existingId = null) {
  const args = existingId ? ['cron', 'edit', existingId] : ['cron', 'add']

  args.push(
    '--name',
    job.name,
    '--cron',
    job.cron,
    '--tz',
    job.tz,
    '--session',
    'isolated',
    '--agent',
    agent,
    '--message',
    buildPrompt(job),
  )

  if (deliver && channel && target) {
    args.push('--announce', '--channel', channel, '--to', target)
  } else {
    args.push('--no-deliver')
  }

  return ['openclaw', ...args]
}

const existingJobs = apply ? listExistingJobs() : new Map()

for (const job of automationJobs) {
  const existing = existingJobs.get(job.name)
  const command = buildCommand(job, existing?.id || null)
  if (apply) {
    execFileSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'inherit' })
  } else {
    emitSummary(command.join(' '))
  }
}
