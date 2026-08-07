import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflowNames = fs
  .readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowsDir, name), 'utf8');
}

function findUnpinnedRemoteActions(source: string): string[] {
  const actions: string[] = [];

  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('#')) {
      continue;
    }
    const action = line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/)?.[1];
    if (action && !action.startsWith('./') && !/@[0-9a-f]{40}$/.test(action)) {
      actions.push(action);
    }
  }

  return actions;
}

function usesWriteAllPermissions(source: string): boolean {
  return /^\s*permissions:\s*write-all\s*$/m.test(source);
}

test('remote-action scanner rejects an unpinned anonymous step', () => {
  assert.deepEqual(findUnpinnedRemoteActions('steps:\n  - uses: actions/checkout@v7\n'), [
    'actions/checkout@v7',
  ]);
});

test('permissions guard rejects job-level write-all', () => {
  assert.equal(usesWriteAllPermissions('jobs:\n  build:\n    permissions: write-all\n'), true);
});

test('every workflow declares least-privilege permissions and pins remote actions by commit SHA', () => {
  const unpinnedActions: string[] = [];
  const missingPermissions: string[] = [];
  const writeAllWorkflows: string[] = [];

  for (const name of workflowNames) {
    const source = readWorkflow(name);

    if (!/^permissions:\s*(?:read-all)?\s*$/m.test(source)) {
      missingPermissions.push(name);
    }
    if (usesWriteAllPermissions(source)) {
      writeAllWorkflows.push(name);
    }

    for (const action of findUnpinnedRemoteActions(source)) {
      unpinnedActions.push(`${name}: ${action}`);
    }
  }

  assert.deepEqual(
    missingPermissions,
    [],
    `workflows missing a top-level permissions block: ${missingPermissions.join(', ')}`,
  );
  assert.deepEqual(writeAllWorkflows, [], 'workflows must not grant write-all permissions');
  assert.deepEqual(
    unpinnedActions,
    [],
    `remote actions must use immutable 40-character commit SHAs: ${unpinnedActions.join(', ')}`,
  );
});

test('official OpenSSF Scorecard publishing is configured with a public badge', () => {
  const scorecard = readWorkflow('scorecard.yml');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  assert.match(scorecard, /^permissions:\s*read-all\s*$/m);
  assert.match(scorecard, /^\s{4}permissions:\s*$/m);
  assert.match(scorecard, /^\s{6}contents:\s*read\s*$/m);
  assert.match(scorecard, /^\s{6}security-events:\s*write\s*$/m);
  assert.match(scorecard, /^\s{6}id-token:\s*write\s*$/m);
  assert.match(
    scorecard,
    /^\s*uses:\s*ossf\/scorecard-action@[0-9a-f]{40}\s+# v2\.4\.4\s*$/m,
  );
  assert.match(scorecard, /^\s*publish_results:\s*true\s*$/m);
  assert.match(
    readme,
    /\[!\[OpenSSF Scorecard\]\(https:\/\/api\.scorecard\.dev\/projects\/github\.com\/DeliciousHouse\/aries-app\/badge\)\]\(https:\/\/scorecard\.dev\/viewer\/\?uri=github\.com\/DeliciousHouse\/aries-app\)/,
  );
});

test('superseded issue-agent and blind-automerge workflows stay retired', () => {
  assert.equal(workflowNames.includes('issue-agent-fix.yml'), false);
  assert.equal(workflowNames.includes('pr-agent-autofix-automerge.yml'), false);

  const activeWorkflowSource = workflowNames.map(readWorkflow).join('\n');
  assert.doesNotMatch(activeWorkflowSource, /agent:auto-merge|pr-agent-autofix-automerge/);
});

test('active goal commands hand draft PRs to the deterministic reviewer lane', () => {
  const commandPaths = [
    '.claude/commands/aries-goal.md',
    '.claude/commands/aries-multibrand-goal.md',
  ];
  const reviewerHandoff =
    'Open a **draft PR** and hand it to the deterministic sanctioned reviewer lane: even PR numbers → `dev-reviewer`; odd PR numbers → `dev-reviewer-2`. Only that assigned lane marks the PR ready and deliberately squash-merges after exact-head CI is green and its review passes.';

  for (const commandPath of commandPaths) {
    const source = fs.readFileSync(path.join(repoRoot, commandPath), 'utf8');
    const normalizedSource = source.replace(/\s+/g, ' ');

    assert.ok(
      normalizedSource.includes(reviewerHandoff),
      `${commandPath} must preserve the reviewer handoff`,
    );
    assert.doesNotMatch(normalizedSource, /ready, not draft|gh pr merge --squash --auto/i);
    assert.doesNotMatch(
      normalizedSource,
      /auto-merge on green CI is the policy|requires? (?:\*\*)?1 approving review(?:\*\*)?/i,
    );
  }
});
