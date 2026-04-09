import { emitSummary, parseArgs } from './lib/common.mjs'
import { buildDailySummary, defaultFeedbackRepo } from './lib/github-feedback.mjs'

const flags = parseArgs()
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
