import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS,
  ARIES_WORKFLOWS,
  getAriesWorkflow,
} from '../backend/execution/workflow-catalog';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const TENANT_WORKFLOW_ROUTE_FILES = [
  'app/api/tenant/workflows/route.ts',
  'app/api/tenant/workflows/[workflowId]/runs/route.ts',
] as const;

test('workflow catalog exposes a definition for every key with a stable shape', () => {
  for (const key of Object.keys(ARIES_WORKFLOWS)) {
    const workflow = getAriesWorkflow(key as keyof typeof ARIES_WORKFLOWS);
    assert.equal(workflow.key, key);
    assert.ok(workflow.mode === 'real' || workflow.mode === 'stub');
    assert.equal(typeof workflow.route, 'string');
  }
});

test('atomic marketing workflow keys are a subset of the catalog', () => {
  for (const key of ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(ARIES_WORKFLOWS, key));
  }
});

test('tenant workflow routes do not import a legacy OpenClaw workflow catalog', async () => {
  for (const relativePath of TENANT_WORKFLOW_ROUTE_FILES) {
    const source = await readFile(path.join(PROJECT_ROOT, relativePath), 'utf8');

    assert.doesNotMatch(source, /backend\/openclaw/);
  }
});
