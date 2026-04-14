import { execFileSync } from 'node:child_process'
import { emitSummary, repoRoot } from './lib/common.mjs'

const scripts = [
  'scripts/automations/private-repo-backup.mjs',
  'scripts/automations/overnight-self-improve.mjs',
  'scripts/automations/daily-brief.mjs',
  'scripts/automations/daily-standup.mjs',
  'scripts/automations/feedback-connector.mjs',
  'scripts/automations/feedback-daily-summary.mjs',
  'scripts/automations/runtime-error-intake.mjs',
  'scripts/automations/rolling-system-reference.mjs',
  'skills/operations/aries-standup-watchdog/scripts/run-watchdog.mjs',
]

for (const script of scripts) {
  execFileSync('node', [script, '--dry-run'], { cwd: repoRoot, stdio: 'inherit' })
}

emitSummary('AUTOMATION VERIFY OK')
