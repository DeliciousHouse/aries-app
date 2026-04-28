import path from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

const SHARED_TEAMS_ROOT = process.env.ARIES_SHARED_TEAMS_ROOT || '/home/node/.openclaw/projects/shared/teams'
const ARIES_REPO_ROOT = process.env.ARIES_CANONICAL_REPO_ROOT || '/home/node/aries-app'
const date = process.argv[2] || new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

const transcriptPath = path.join(SHARED_TEAMS_ROOT, 'meetings', `${date}-daily-standup.md`)
const reportDir = path.join(SHARED_TEAMS_ROOT, 'standups', date)
const expectedReports = ['forge-report.json', 'signal-report.json', 'ledger-report.json']
const forbiddenPaths = [
  `${ARIES_REPO_ROOT}/team/meetings/${date}-daily-standup.md`,
  `${ARIES_REPO_ROOT}/team/standups/${date}`,
  `/home/node/.openclaw/projects/shared/team/meetings/${date}-daily-standup.md`,
  `/home/node/.openclaw/projects/shared/team/standups/${date}`,
]

const missing = []
if (!existsSync(transcriptPath)) missing.push(`missing transcript ${transcriptPath}`)
for (const file of expectedReports) {
  const full = path.join(reportDir, file)
  if (!existsSync(full)) missing.push(`missing report ${full}`)
}

const forbidden = forbiddenPaths.filter((target) => existsSync(target))
const reportCount = existsSync(reportDir) ? readdirSync(reportDir).filter((entry) => entry.endsWith('.json')).length : 0

if (!missing.length && !forbidden.length) {
  process.stdout.write([
    'STANDUP WATCHDOG OK',
    `- date: ${date}`,
    `- transcript: ${transcriptPath}`,
    `- reports: ${reportCount} json file(s) in ${reportDir}`,
    '- forbidden drift: none detected',
  ].join('\n') + '\n')
  process.exit(0)
}

process.stdout.write([
  missing.length ? 'STANDUP WATCHDOG PARTIAL' : 'STANDUP WATCHDOG FAILED',
  `- date: ${date}`,
  ...missing.map((line) => `- ${line}`),
  ...forbidden.map((line) => `- forbidden artifact present: ${line}`),
  '- next action: rerun the daily standup or remove the forbidden-path writer before the next scheduled run',
].join('\n') + '\n')

process.exit(0)
