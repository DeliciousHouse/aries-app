import { execFileSync } from 'node:child_process'
import { automationJobs } from './manifest.mjs'
import { emitSummary, parseArgs, repoRoot } from './lib/common.mjs'

const flags = parseArgs()
const apply = flags.has('--apply')
const deliver = flags.has('--announce')
const agent = process.env.ARIES_CRON_AGENT || 'default'
const channel = process.env.ARIES_CRON_CHANNEL || ''
const target = process.env.ARIES_CRON_TARGET || ''

function buildPrompt(skill) {
  return [
    'Work in /app/aries-app.',
    `Use the ${skill} skill.`,
    'Follow the skill exactly.',
    'Return only the concise operational summary defined by the skill.',
  ].join(' ')
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
    buildPrompt(job.skill),
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
