import { currentDateInfo, emitSummary, gitChangedFiles, parseArgs, retry, run } from './lib/common.mjs'

const flags = parseArgs()
const dryRun = flags.has('--dry-run')
const remote = process.env.ARIES_BACKUP_REMOTE || 'origin'
const baseBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'main'
const backupBranch = process.env.ARIES_BACKUP_BRANCH || `backup/${sanitizeBranch(baseBranch)}`
const remoteUrl = run('git', ['remote', 'get-url', remote])
const restorePlan = {
  switched: false,
  stashRef: null,
  restoreError: null,
}

function sanitizeBranch(value) {
  return String(value)
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
}

function fail(lines) {
  const output = [...lines]
  if (restorePlan.restoreError) {
    output.push(`- restore-warning: ${restorePlan.restoreError}`)
  }
  emitSummary(output)
  process.exit(1)
}

function restoreWorkspace() {
  const errors = []

  if (restorePlan.switched) {
    const back = run('git', ['switch', baseBranch])
    if (!back.ok) {
      errors.push(`switch ${baseBranch} failed: ${back.stderr.trim() || back.stdout.trim() || 'unknown error'}`)
    }
  }

  if (restorePlan.stashRef) {
    const pop = run('git', ['stash', 'pop', '--index', restorePlan.stashRef])
    if (!pop.ok) {
      errors.push(`stash restore failed: ${pop.stderr.trim() || pop.stdout.trim() || 'unknown error'}`)
    }
  }

  if (errors.length > 0) {
    restorePlan.restoreError = errors.join(' | ')
  }
}

if (!remoteUrl.ok) {
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    '- reason: configured backup remote was not found',
    '- next: set ARIES_BACKUP_REMOTE or add the remote before enabling the cron job',
  ])
}

if (!/github\.com[:/]/.test(remoteUrl.stdout)) {
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- url: ${remoteUrl.stdout.trim()}`,
    '- reason: backup remote is not a GitHub remote; this automation is intended for a private GitHub backup target',
  ])
}

const stage = run('git', ['add', '-A'])
if (!stage.ok) {
  fail(['BACKUP FAILED', '- reason: git add -A failed', `- stderr: ${stage.stderr.trim() || 'none'}`])
}

const changed = gitChangedFiles(['diff', '--cached', '--name-status'])
if (changed.length === 0) {
  emitSummary([
    'BACKUP OK',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    '- result: no staged changes; nothing to back up',
  ])
  process.exit(0)
}

const { stamp } = currentDateInfo()
const preview = changed.slice(0, 4).map((line) => line.split(/\s+/).slice(-1)[0]).join(', ')
const commitMessage = `chore(backup): snapshot ${stamp} :: ${changed.length} file(s) :: ${preview}`
const prTitle = `Backup snapshot — ${stamp}`
const prBody = [
  'Automated backup PR created by the Aries private repo backup job.',
  '',
  `- base branch: ${baseBranch}`,
  `- backup branch: ${backupBranch}`,
  `- snapshot commit: ${commitMessage}`,
  `- changed files: ${changed.length}`,
  '',
  '## Included paths',
  ...changed.map((line) => `- ${line}`),
].join('\n')

if (dryRun) {
  emitSummary([
    'BACKUP DRY RUN',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    `- commit: ${commitMessage}`,
    `- changed: ${changed.join('; ')}`,
  ])
  process.exit(0)
}

const setupGit = run('gh', ['auth', 'setup-git'])
if (!setupGit.ok) {
  fail([
    'BACKUP FAILED',
    '- reason: gh auth setup-git failed',
    `- stderr: ${setupGit.stderr.trim() || setupGit.stdout.trim() || 'none'}`,
  ])
}

const stashLabel = `aries-backup-${Date.now()}`
const stash = run('git', ['stash', 'push', '-u', '-m', stashLabel])
if (!stash.ok) {
  fail([
    'BACKUP FAILED',
    '- reason: git stash failed before creating backup branch',
    `- stderr: ${stash.stderr.trim() || stash.stdout.trim() || 'none'}`,
  ])
}
restorePlan.stashRef = 'stash@{0}'

const switchBranch = run('git', ['switch', '-C', backupBranch, baseBranch])
if (!switchBranch.ok) {
  restoreWorkspace()
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    '- reason: could not create or switch to backup branch',
    `- stderr: ${switchBranch.stderr.trim() || switchBranch.stdout.trim() || 'none'}`,
  ])
}
restorePlan.switched = true

const applyStash = run('git', ['stash', 'apply', '--index', restorePlan.stashRef])
if (!applyStash.ok) {
  restoreWorkspace()
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    '- reason: could not restore staged changes onto backup branch',
    `- stderr: ${applyStash.stderr.trim() || applyStash.stdout.trim() || 'none'}`,
  ])
}

const commit = run('git', ['commit', '-m', commitMessage])
if (!commit.ok) {
  restoreWorkspace()
  fail([
    'BACKUP FAILED',
    '- reason: git commit failed on backup branch',
    `- stderr: ${commit.stderr.trim() || commit.stdout.trim() || 'none'}`,
  ])
}

try {
  retry((attempt) => {
    const push = run('git', ['push', '--force-with-lease', remote, `${backupBranch}:${backupBranch}`])
    if (!push.ok) {
      throw new Error(`attempt ${attempt}: ${push.stderr.trim() || push.stdout.trim() || 'git push failed'}`)
    }
    return push
  })
} catch (error) {
  restoreWorkspace()
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    `- commit: ${commitMessage}`,
    `- reason: ${error instanceof Error ? error.message : 'push failed'}`,
    '- recovery: backup commit remains on the backup branch; restore warning may indicate whether the original workspace was fully restored',
  ])
}

const existingPr = run('gh', ['pr', 'list', '--head', backupBranch, '--base', baseBranch, '--state', 'open', '--json', 'number,url'])
if (!existingPr.ok) {
  restoreWorkspace()
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    '- reason: could not inspect existing backup PRs',
    `- stderr: ${existingPr.stderr.trim() || existingPr.stdout.trim() || 'none'}`,
  ])
}

let prAction = 'created'
let prUrl = ''

try {
  const parsed = JSON.parse(existingPr.stdout || '[]')
  if (Array.isArray(parsed) && parsed.length > 0) {
    const current = parsed[0]
    prUrl = current.url || ''
    prAction = 'updated'
    const edit = run('gh', ['pr', 'edit', String(current.number), '--title', prTitle, '--body', prBody])
    if (!edit.ok) {
      throw new Error(edit.stderr.trim() || edit.stdout.trim() || 'gh pr edit failed')
    }
  } else {
    const create = run('gh', ['pr', 'create', '--base', baseBranch, '--head', backupBranch, '--title', prTitle, '--body', prBody])
    if (!create.ok) {
      throw new Error(create.stderr.trim() || create.stdout.trim() || 'gh pr create failed')
    }
    prUrl = create.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || ''
  }
} catch (error) {
  restoreWorkspace()
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    `- commit: ${commitMessage}`,
    `- reason: ${error instanceof Error ? error.message : 'backup PR failed'}`,
    '- recovery: backup branch was pushed; create or inspect the PR manually if needed',
  ])
}

restoreWorkspace()
if (restorePlan.restoreError) {
  fail([
    'BACKUP FAILED',
    `- remote: ${remote}`,
    `- base: ${baseBranch}`,
    `- backup-branch: ${backupBranch}`,
    `- commit: ${commitMessage}`,
    `- pr: ${prUrl || 'created but URL unavailable'}`,
    `- reason: backup PR ${prAction}, but the original workspace could not be fully restored`,
  ])
}

emitSummary([
  'BACKUP OK',
  `- remote: ${remote}`,
  `- base: ${baseBranch}`,
  `- backup-branch: ${backupBranch}`,
  `- commit: ${commitMessage}`,
  `- changed: ${changed.length} file(s) captured in backup branch`,
  `- pr-action: ${prAction}`,
  `- pr: ${prUrl || 'created but URL unavailable'}`,
])
