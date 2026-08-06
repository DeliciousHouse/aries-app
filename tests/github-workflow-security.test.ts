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

test('every workflow declares least-privilege permissions and pins remote actions by commit SHA', () => {
  const unpinnedActions: string[] = [];
  const missingPermissions: string[] = [];
  const writeAllWorkflows: string[] = [];

  for (const name of workflowNames) {
    const source = readWorkflow(name);

    if (!/^permissions:\s*(?:read-all)?\s*$/m.test(source)) {
      missingPermissions.push(name);
    }
    if (/^permissions:\s*write-all\s*$/m.test(source)) {
      writeAllWorkflows.push(name);
    }

    for (const line of source.split('\n')) {
      if (line.trimStart().startsWith('#')) {
        continue;
      }
      const action = line.match(/^\s*uses:\s*([^\s#]+)/)?.[1];
      if (!action || action.startsWith('./')) {
        continue;
      }
      if (!/@[0-9a-f]{40}$/.test(action)) {
        unpinnedActions.push(`${name}: ${action}`);
      }
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
