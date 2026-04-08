import process from 'node:process'
import { emitSummary, parseArgs, run } from './lib/common.mjs'

const flags = parseArgs()
const issueIndex = process.argv.indexOf('--issue')
const issueNumber = issueIndex > -1 ? process.argv[issueIndex + 1] : ''
const branchIndex = process.argv.indexOf('--branch')
const branch = branchIndex > -1 ? process.argv[branchIndex + 1] : ''
const typeIndex = process.argv.indexOf('--type')
const workflowType = typeIndex > -1 ? process.argv[typeIndex + 1] : 'bug'
const dryRun = flags.has('--dry-run')

const deployCommand = process.env.ARIES_STAGING_DEPLOY_COMMAND || ''
const verifyUrl = process.env.ARIES_STAGING_VERIFY_URL || ''
const verifyText = process.env.ARIES_STAGING_VERIFY_TEXT || ''

async function verify() {
  if (!verifyUrl) return { ok: true, detail: 'no-verify-url' }
  const response = await fetch(verifyUrl)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`staging verify failed with ${response.status}`)
  }
  if (verifyText && !body.includes(verifyText)) {
    throw new Error(`staging verify text missing: ${verifyText}`)
  }
  return { ok: true, detail: verifyUrl }
}

async function main() {
  if (!deployCommand) {
    throw new Error('ARIES_STAGING_DEPLOY_COMMAND is not configured')
  }

  if (dryRun) {
    emitSummary([
      'status: dry-run',
      `issue: #${issueNumber || 'unknown'}`,
      `branch: ${branch || 'unknown'}`,
      `type: ${workflowType}`,
      `deploy_command: ${deployCommand}`,
      `verify_url: ${verifyUrl || 'none'}`,
    ])
    return
  }

  const result = run('sh', ['-lc', deployCommand], {
    env: {
      ...process.env,
      ARIES_ISSUE_NUMBER: issueNumber,
      ARIES_BRANCH_NAME: branch,
      ARIES_WORKFLOW_TYPE: workflowType,
    },
  })

  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'staging deploy command failed')
  }

  const verifyResult = await verify()
  emitSummary([
    'status: success',
    `issue: #${issueNumber || 'unknown'}`,
    `branch: ${branch || 'unknown'}`,
    `staging: ${verifyUrl || 'configured-no-url'}`,
    `verify: ${verifyResult.detail}`,
  ])
}

main().catch((error) => {
  emitSummary(`status: failed\nerror: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
