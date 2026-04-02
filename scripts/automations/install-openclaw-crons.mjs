import { execFileSync } from 'node:child_process'
import { automationJobs } from './manifest.mjs'
import { emitSummary, parseArgs, repoRoot } from './lib/common.mjs'

const flags = parseArgs()
const apply = flags.has('--apply')
const deliver = flags.has('--announce')
const agent = process.env.ARIES_CRON_AGENT || 'default'
const channel = process.env.ARIES_CRON_CHANNEL || ''
const target = process.env.ARIES_CRON_TARGET || ''

function buildPrompt(script) {
  return [
    'Work in /app/aries-app.',
    `Run ${script}.`,
    'If the script reports an error, return a concise failure summary with the next corrective action.',
    'If the script succeeds, return only the concise alert summary emitted by the script.',
  ].join(' ')
}

function buildCommand(job) {
  const args = [
    'cron',
    'add',
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
    buildPrompt(job.script),
  ]

  if (deliver && channel && target) {
    args.push('--announce', '--channel', channel, '--to', target)
  } else {
    args.push('--no-deliver')
  }

  return ['openclaw', ...args]
}

for (const job of automationJobs) {
  const command = buildCommand(job)
  if (apply) {
    execFileSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'inherit' })
  } else {
    emitSummary(command.join(' '))
  }
}
