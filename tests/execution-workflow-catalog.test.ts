import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS as LEGACY_ATOMIC_MARKETING_WORKFLOW_KEYS,
  ARIES_OPENCLAW_WORKFLOWS,
} from '../backend/openclaw/workflow-catalog';
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

test('Aries-owned workflow catalog preserves every legacy workflow definition', () => {
  assert.deepEqual(Object.keys(ARIES_WORKFLOWS).sort(), Object.keys(ARIES_OPENCLAW_WORKFLOWS).sort());
  assert.deepEqual(ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS, LEGACY_ATOMIC_MARKETING_WORKFLOW_KEYS);

  for (const key of Object.keys(ARIES_OPENCLAW_WORKFLOWS)) {
    const legacyWorkflow = ARIES_OPENCLAW_WORKFLOWS[key as keyof typeof ARIES_OPENCLAW_WORKFLOWS];
    const workflow = getAriesWorkflow(key as keyof typeof ARIES_WORKFLOWS);

    assert.deepEqual(workflow, legacyWorkflow);
  }
});

test('tenant workflow routes import the Aries-owned workflow catalog', async () => {
  for (const relativePath of TENANT_WORKFLOW_ROUTE_FILES) {
    const source = await readFile(path.join(PROJECT_ROOT, relativePath), 'utf8');

    assert.match(source, /@\/backend\/execution(?:\/workflow-catalog)?['"/]/);
    assert.doesNotMatch(source, /@\/backend\/openclaw\/workflow-catalog/);
  }
});
