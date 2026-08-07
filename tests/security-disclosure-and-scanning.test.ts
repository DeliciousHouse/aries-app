import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const securityPolicy = readFileSync(path.join(PROJECT_ROOT, 'SECURITY.md'), 'utf8');
const securityWorkflowPath = path.join(PROJECT_ROOT, '.github', 'workflows', 'security-scans.yml');

test('security policy defines private coordinated disclosure and response service levels', () => {
  assert.match(
    securityPolicy,
    /https:\/\/github\.com\/DeliciousHouse\/aries-app\/security\/advisories\/new/,
  );
  assert.match(securityPolicy, /acknowledge[^\n]*within 2 business days/i);
  assert.match(securityPolicy, /initial triage[^\n]*within 7 calendar days/i);
  assert.match(securityPolicy, /critical[^\n]*7 calendar days/i);
  assert.match(securityPolicy, /high[^\n]*30 calendar days/i);
  assert.match(securityPolicy, /medium[^\n]*60 calendar days/i);
  assert.match(securityPolicy, /low[\s\S]{0,50}90 calendar days/i);
  assert.match(securityPolicy, /coordinated disclosure[^\n]*90 calendar days/i);
  assert.match(securityPolicy, /GitHub Security Advisories/i);
});

test('security policy provides safe harbor and guards sensitive findings', () => {
  assert.match(securityPolicy, /safe harbor/i);
  assert.match(securityPolicy, /authorized/i);
  assert.match(securityPolicy, /will not initiate or recommend legal action/i);
  assert.match(securityPolicy, /good faith/i);
  assert.match(securityPolicy, /privacy/i);
  assert.match(securityPolicy, /do not open a public (?:GitHub )?issue/i);
  assert.match(securityPolicy, /not a bug bounty/i);
});

test('warn-only security workflow scans dependencies and full git history', () => {
  assert.equal(existsSync(securityWorkflowPath), true, 'security-scans.yml should exist');
  const workflow = readFileSync(securityWorkflowPath, 'utf8');

  assert.match(workflow, /^name: Security Scans$/m);
  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  push:\s*\n    branches: \[master\]$/m);
  assert.match(workflow, /^  schedule:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^permissions:\s*\n  contents: read$/m);
  assert.match(workflow, /^  dependency-audit:\s*$/m);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /^  secret-scan:\s*$/m);
  assert.match(workflow, /GITLEAKS_VERSION: ['"]8\.30\.1['"]/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /gitleaks git/);
  assert.match(workflow, /--log-opts=['"]--all['"]/);
  assert.match(workflow, /--redact=100/);
  assert.match(workflow, /--exit-code 2/);
  assert.doesNotMatch(workflow, /--verbose/);
  assert.match(workflow, /\n\s+\.\s*>\s*\/dev\/null\s+2>&1\r?\n\s+scan_status=\$\?/);
  assert.match(workflow, /::warning(?: title=[^:]*)?::/);
  assert.match(workflow, /exit 0/);
  assert.match(workflow, /fetch-depth: 0/);

  const actionRefs = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionRefs.length >= 2, 'workflow should use checkout and setup-node');
  for (const ref of actionRefs) {
    assert.match(ref, /^[0-9a-f]{40}$/, `action ref ${ref} must be an immutable commit SHA`);
  }
});

test('security policy records a dated promotion-to-blocking plan', () => {
  assert.match(securityPolicy, /warn-only/i);
  assert.match(securityPolicy, /2026-09-05/);
  assert.match(securityPolicy, /promot[^\n]*blocking/i);
  assert.match(securityPolicy, /new secret findings[^\n]*block/i);
  assert.match(securityPolicy, /high and[\s\S]{0,80}critical[^\n]*block/i);
  assert.match(securityPolicy, /no history rewrite/i);
});
