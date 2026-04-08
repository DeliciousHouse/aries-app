import test from 'node:test'
import assert from 'node:assert/strict'

// @ts-ignore relative .mjs automation module has no generated declaration surface yet
const modPromise = import('../scripts/automations/lib/github-feedback.mjs')

test('classifyIssue treats bug label as bug', async () => {
  const mod = await modPromise
  const result = mod.classifyIssue({
    title: 'Dashboard crashes after login',
    body: 'Steps to reproduce: sign in, visit dashboard, app crashes.',
    labels: [{ name: 'bug' }],
  })

  assert.equal(result.type, 'bug')
  assert.equal(result.source, 'label')
})

test('classifyIssue treats enhancement label as feature', async () => {
  const mod = await modPromise
  const result = mod.classifyIssue({
    title: 'Add campaign archive view',
    body: 'Feature request for better historical visibility.',
    labels: [{ name: 'enhancement' }],
  })

  assert.equal(result.type, 'feature')
})

test('buildDailySummary renders noncritical items and ignores critical ones', async () => {
  const mod = await modPromise
  const summary = mod.buildDailySummary({
    dryRun: true,
    log: {
    version: 1,
    repo: 'DeliciousHouse/aries-app',
    lastSyncAt: null,
    lastDailySummaryAt: null,
    items: [
      {
        issueNumber: 10,
        classification: { type: 'bug' },
        severity: 'high',
        status: 'staged',
        branch: 'bugfix/issue-10-login-loop',
        stagingUrl: 'https://staging.example.com',
        summaryPending: true,
        lastProcessedAt: '2026-04-07T16:00:00.000Z',
      },
      {
        issueNumber: 11,
        classification: { type: 'feature' },
        approvalDecision: 'rejected',
        approvalReason: 'outside current roadmap focus',
        summaryPending: true,
        lastProcessedAt: '2026-04-07T17:00:00.000Z',
      },
      {
        issueNumber: 12,
        classification: { type: 'bug' },
        severity: 'critical',
        status: 'staged',
        summaryPending: true,
        lastProcessedAt: '2026-04-07T18:00:00.000Z',
      },
    ],
    },
  })
  assert.match(summary.text, /BUG #10 \[high\] staged/)
  assert.match(summary.text, /FEATURE #11 rejected/)
  assert.doesNotMatch(summary.text, /#12/)
})
