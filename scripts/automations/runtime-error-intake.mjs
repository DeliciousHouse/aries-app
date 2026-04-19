import process from 'node:process'
import { emitScanSummary, getPendingRuntimeIncidents, markRuntimeIncident, printJson, scanRuntimeErrors } from './lib/runtime-errors.mjs'
import { parseArgs } from './lib/common.mjs'

const flags = parseArgs()
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const command = args[0] || 'scan'
const dryRun = flags.has('--dry-run')
const asJson = flags.has('--json') || command === 'pending' || command === 'mark'
const withBuild = flags.has('--with-build')
const withAutomationVerify = flags.has('--with-automation-verify')
const incidentIndex = process.argv.indexOf('--incident')
const incidentId = incidentIndex > -1 ? process.argv[incidentIndex + 1] : ''
const patchIndex = process.argv.indexOf('--patch-json')
const patchJson = patchIndex > -1 ? process.argv[patchIndex + 1] : '{}'
const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) : 50

try {
  if (command === 'pending') {
    const pending = getPendingRuntimeIncidents().slice(0, limit)
    if (asJson) {
      printJson(pending)
    } else {
      process.stdout.write(`pending: ${pending.length}\n`)
    }
    process.exit(0)
  }

  if (command === 'mark') {
    const patch = JSON.parse(patchJson)
    const result = markRuntimeIncident({ incidentId, patch, dryRun })
    printJson(result.item)
    process.exit(0)
  }

  const result = scanRuntimeErrors({ withBuild, withAutomationVerify, dryRun })
  if (asJson) {
    printJson({
      status: result.stats.failedChecks > 0 ? 'attention' : 'ok',
      mode: dryRun ? 'dry-run' : 'live',
      scanAt: result.scanAt,
      stats: result.stats,
      pending: result.pending,
      escalated: result.escalated,
      unresolved: result.unresolved,
      summary: result.summary,
    })
  } else {
    emitScanSummary(result, { dryRun })
  }
} catch (error) {
  process.stdout.write(`status: failed\nerror: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
