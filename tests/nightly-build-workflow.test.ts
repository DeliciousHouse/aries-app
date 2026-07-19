import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const workflowsDir = path.join(PROJECT_ROOT, '.github', 'workflows');
const testsWorkflow = readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8');

test('nightly build schedules the reusable verification suite on the default branch', () => {
  const nightlyPath = path.join(workflowsDir, 'nightly.yml');
  assert.equal(existsSync(nightlyPath), true, 'nightly.yml should exist');

  const nightlyWorkflow = readFileSync(nightlyPath, 'utf8');
  assert.match(nightlyWorkflow, /^name: Nightly Build$/m);
  assert.match(nightlyWorkflow, /^run-name: Nightly Build .*github\.ref_name/m);
  assert.match(
    nightlyWorkflow,
    /^# Contract: dev-lead's 07:45 PT morning Jira intake consumes this surfacing-only run; it never auto-fixes, creates issues, deploys, or merges\.$/m,
  );
  assert.match(nightlyWorkflow, /^  schedule:\s*\n    - cron: ['"]0 9 \* \* \*['"]$/m);
  assert.match(nightlyWorkflow, /^  workflow_dispatch:\s*$/m);
  assert.match(nightlyWorkflow, /^permissions:\s*\n  contents: read$/m);
  assert.match(
    nightlyWorkflow,
    /^jobs:\s*\n  full-suite:\s*\n    uses: \.\/\.github\/workflows\/tests\.yml$/m,
  );
  assert.doesNotMatch(nightlyWorkflow, /(?:issues|pull-requests|actions|packages):\s*write/);
  assert.doesNotMatch(nightlyWorkflow, /deploy\.yml|gh\s+(?:issue|pr)\s+create/);
});

test('full verification is reusable and preserves failure logs for triage', () => {
  assert.match(testsWorkflow, /^  workflow_call:\s*$/m);
  assert.match(testsWorkflow, /^      - name: Build$/m);
  assert.match(testsWorkflow, /npm run build 2>&1 \| tee "\$\{ARTIFACT_DIR\}\/build\.log"/);
  assert.match(
    testsWorkflow,
    /npx --no-install tsx --test --test-concurrency=1 "\$\{TEST_FILES\[@\]\}" 2>&1 \| tee "\$\{ARTIFACT_DIR\}\/full-tests\.log"/,
  );
  assert.match(testsWorkflow, /^      - name: Upload failure logs$/m);
  assert.match(testsWorkflow, /^        if: \$\{\{ failure\(\) \}\}$/m);
  assert.match(testsWorkflow, /uses: actions\/upload-artifact@v4/);
  assert.match(testsWorkflow, /^          path: \$\{\{ env\.ARTIFACT_DIR \}\}$/m);
});
