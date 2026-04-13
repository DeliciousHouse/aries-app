import process from 'node:process'
import { emitSummary, parseArgs, preflightOrExit, repoRoot } from './lib/common.mjs'
import { buildDailySummary, defaultFeedbackRepo } from './lib/github-feedback.mjs'

const flags = parseArgs()
const preflightOnly = flags.has('--preflight')

preflightOrExit('FEEDBACK DAILY SUMMARY', {
  binaries: ['gh'],
  paths: [
    { label: 'repo root', path: repoRoot, type: 'dir' },
    { label: 'feedback log', path: `${repoRoot}/data/feedback-processing-log.json`, type: 'file' },
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}
const repoIndex = process.argv.indexOf('--repo')
const repo = repoIndex > -1 ? process.argv[repoIndex + 1] : defaultFeedbackRepo
const markSent = flags.has('--mark-sent')
const dryRun = flags.has('--dry-run')

try {
  const result = buildDailySummary({ repo, markSent, dryRun })
  emitSummary(result.text)
} catch (error) {
  emitSummary(`status: failed\nerror: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
