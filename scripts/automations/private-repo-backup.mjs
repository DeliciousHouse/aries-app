import { currentDateInfo, emitSummary, gitChangedFiles, parseArgs, retry, run } from './lib/common.mjs'

const flags = parseArgs()
const dryRun = flags.has('--dry-run')
const remote = process.env.ARIES_BACKUP_REMOTE || 'origin'
const branch = process.env.ARIES_BACKUP_BRANCH || run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'main'
const remoteUrl = run('git', ['remote', 'get-url', remote])

if (!remoteUrl.ok) {
  emitSummary([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    '- reason: configured backup remote was not found',
    '- next: set ARIES_BACKUP_REMOTE or add the remote before enabling the cron job',
  ])
  process.exit(1)
}

if (!/github\.com[:/]/.test(remoteUrl.stdout)) {
  emitSummary([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- url: ${remoteUrl.stdout.trim()}`,
    '- reason: backup remote is not a GitHub remote; this automation is intended for a private GitHub backup target',
  ])
  process.exit(1)
}

const stage = run('git', ['add', '-A'])
if (!stage.ok) {
  emitSummary(['BACKUP FAILED', '- reason: git add -A failed', `- stderr: ${stage.stderr.trim() || 'none'}`])
  process.exit(1)
}

const changed = gitChangedFiles(['diff', '--cached', '--name-status'])
if (changed.length === 0) {
  emitSummary([
    'BACKUP OK',
    `- remote: ${remote}`,
    `- branch: ${branch}`,
    '- result: no staged changes; nothing to push',
  ])
  process.exit(0)
}

const { stamp } = currentDateInfo()
const preview = changed.slice(0, 4).map((line) => line.split(/\s+/).slice(-1)[0]).join(', ')
const commitMessage = `chore(backup): snapshot ${stamp} :: ${changed.length} file(s) :: ${preview}`

if (dryRun) {
  emitSummary([
    'BACKUP DRY RUN',
    `- remote: ${remote}`,
    `- branch: ${branch}`,
    `- commit: ${commitMessage}`,
    `- changed: ${changed.join('; ')}`,
  ])
  process.exit(0)
}

const commit = run('git', ['commit', '-m', commitMessage])
if (!commit.ok) {
  emitSummary([
    'BACKUP FAILED',
    '- reason: git commit failed',
    `- stderr: ${commit.stderr.trim() || commit.stdout.trim() || 'none'}`,
  ])
  process.exit(1)
}

try {
  retry((attempt) => {
    const push = run('git', ['push', remote, branch])
    if (!push.ok) {
      throw new Error(`attempt ${attempt}: ${push.stderr.trim() || push.stdout.trim() || 'git push failed'}`)
    }
    return push
  })
} catch (error) {
  emitSummary([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- branch: ${branch}`,
    `- commit: ${commitMessage}`,
    `- reason: ${error instanceof Error ? error.message : 'push failed'}`,
    '- recovery: git reset --soft HEAD~1 to unroll the backup commit before retrying',
  ])
  process.exit(1)
}

emitSummary([
  'BACKUP OK',
  `- remote: ${remote}`,
  `- branch: ${branch}`,
  `- commit: ${commitMessage}`,
  `- changed: ${changed.length} file(s) pushed successfully`,
])
