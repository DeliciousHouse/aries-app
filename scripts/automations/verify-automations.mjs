import { execFileSync } from 'node:child_process'
import { emitSummary, repoRoot } from './lib/common.mjs'

const scripts = [
  'scripts/automations/private-repo-backup.mjs',
  'scripts/automations/overnight-self-improve.mjs',
  'scripts/automations/daily-brief.mjs',
  'scripts/automations/rolling-system-reference.mjs',
]

for (const script of scripts) {
  execFileSync('node', [script, '--dry-run'], { cwd: repoRoot, stdio: 'inherit' })
}

emitSummary('AUTOMATION VERIFY OK')
