import { spawnSync } from 'node:child_process'

const result = spawnSync('node', ['scripts/automations/daily-standup.mjs', ...process.argv.slice(2)], {
  cwd: process.env.ARIES_CANONICAL_REPO_ROOT || '/home/node/aries-app',
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
