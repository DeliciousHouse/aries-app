import process from 'node:process'
import { emitSummary, parseArgs, preflightOrExit, repoRoot } from './lib/common.mjs'
import { defaultFeedbackRepo, getPendingItems, markFeedbackItem, printJson, syncFeedbackIssues } from './lib/github-feedback.mjs'

const flags = parseArgs()
const preflightOnly = flags.has('--preflight')

preflightOrExit('FEEDBACK CONNECTOR', {
  binaries: ['gh'],
  paths: [
    { label: 'repo root', path: repoRoot, type: 'dir' },
    { label: 'feedback log', path: `${repoRoot}/data/feedback-processing-log.json`, type: 'file' },
  ],
}, { preflightOnly })

if (preflightOnly) {
  process.exit(0)
}
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const command = args[0] || 'sync'
const repoIndex = process.argv.indexOf('--repo')
const repo = repoIndex > -1 ? process.argv[repoIndex + 1] : defaultFeedbackRepo
const typeIndex = process.argv.indexOf('--type')
const type = typeIndex > -1 ? process.argv[typeIndex + 1] : null
const numberIndex = process.argv.indexOf('--number')
const number = numberIndex > -1 ? Number(process.argv[numberIndex + 1]) : null
const patchIndex = process.argv.indexOf('--patch-json')
const patchJson = patchIndex > -1 ? process.argv[patchIndex + 1] : '{}'
const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) : 100
const dryRun = flags.has('--dry-run')
const asJson = flags.has('--json') || command === 'pending' || command === 'mark'

try {
  if (command === 'pending') {
    const pending = getPendingItems({ repo, type })
    if (asJson) {
      printJson(pending)
    } else {
      emitSummary(`pending: ${pending.length}`)
    }
    process.exit(0)
  }

  if (command === 'mark') {
    const patch = JSON.parse(patchJson)
    const result = markFeedbackItem({ repo, number, patch, dryRun })
    printJson(result.item)
    process.exit(0)
  }

  const result = syncFeedbackIssues({ repo, limit, dryRun })
  const payload = {
    repo,
    stats: result.stats,
    pending: result.pending.map((item) => ({
      issueNumber: item.issueNumber,
      title: item.title,
      type: item.classification?.type,
      reason: item.classification?.reason,
      url: item.url,
    })),
  }

  if (asJson) {
    printJson(payload)
  } else {
    emitSummary([
      `status: ${dryRun ? 'dry-run' : 'success'}`,
      `repo: ${repo}`,
      `scanned: ${result.stats.scanned}`,
      `new: ${result.stats.new}`,
      `requeued: ${result.stats.requeued}`,
      `pending: ${result.pending.length}`,
    ])
  }
} catch (error) {
  emitSummary(`status: failed\nerror: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
