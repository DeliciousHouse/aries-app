import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'backend', 'onboarding', 'draft-store.ts'),
  'utf8',
);

test('claimOnboardingDraftMaterialization atomically claims ready_for_auth drafts exactly once', () => {
  assert.match(source, /export async function claimOnboardingDraftMaterialization/);
  assert.match(source, /WHERE draft_id = \$1 AND status = 'ready_for_auth'/);
  assert.match(source, /SET status = 'materializing'/);
  assert.match(source, /claimed: true/);
  assert.match(source, /claimed: false/);
});
