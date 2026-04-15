import { execFileSync } from 'node:child_process'
import { emitSummary, repoRoot, resolveBinary } from './lib/common.mjs'

const nodeBin = resolveBinary('node') || process.execPath

const preflightScripts = [
  'scripts/automations/daily-brief.mjs',
  'scripts/automations/daily-standup.mjs',
  'scripts/automations/feedback-connector.mjs',
  'scripts/automations/feedback-daily-summary.mjs',
  'scripts/automations/runtime-error-intake.mjs',
  'scripts/automations/ci-watcher-dispatch.mjs',
  'scripts/automations/rolling-system-reference.mjs',
  'scripts/automations/weekly-review.mjs',
]

const dryRunScripts = [
  'scripts/automations/daily-brief.mjs',
  'scripts/automations/daily-standup.mjs',
  'scripts/automations/feedback-connector.mjs',
  'scripts/automations/feedback-daily-summary.mjs',
  'scripts/automations/rolling-system-reference.mjs',
  'scripts/automations/weekly-review.mjs',
]

for (const script of preflightScripts) {
  execFileSync(nodeBin, [script, '--preflight'], { cwd: repoRoot, stdio: 'inherit' })
}

for (const script of dryRunScripts) {
  execFileSync(nodeBin, [script, '--dry-run'], { cwd: repoRoot, stdio: 'inherit' })
}

emitSummary('AUTOMATION VERIFY OK')
