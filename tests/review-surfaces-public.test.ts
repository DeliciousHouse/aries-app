import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('client review surfaces do not expose generic internal workflow copy', () => {
  const combined = [
    'backend/marketing/runtime-views.ts',
    'frontend/aries-v1/review-item.tsx',
    'frontend/aries-v1/review-queue.tsx',
    'frontend/aries-v1/campaign-workspace.tsx',
    'frontend/marketing/job-status.tsx',
    'frontend/marketing/job-approve.tsx',
  ].map(readRepoFile).join('\n');

  assert.doesNotMatch(combined, /Workflow checkpoint/);
  assert.doesNotMatch(combined, /Workflow state/);
  assert.doesNotMatch(combined, /\bCheckpoint\b/);
  assert.doesNotMatch(combined, /Decision guidance/);
  assert.doesNotMatch(combined, /Supporting artifacts/);
  assert.doesNotMatch(combined, /Generated artifacts/);
  assert.doesNotMatch(combined, /Aries workflow/);
  assert.doesNotMatch(combined, /internal status and approval routes/);
  assert.doesNotMatch(combined, /internal approval route/);
  assert.doesNotMatch(combined, /Resume a paused marketing workflow/);
  assert.doesNotMatch(combined, /placeholder="operator"/);
  assert.doesNotMatch(combined, /actedBy: 'operator'/);
});

test('client review surfaces hide empty evidence placeholders and keep client-safe labels', () => {
  const reviewItemSource = readRepoFile('frontend/aries-v1/review-item.tsx');
  const workspaceSource = readRepoFile('frontend/aries-v1/campaign-workspace.tsx');
  const queueSource = readRepoFile('frontend/aries-v1/review-queue.tsx');
  const approveSource = readRepoFile('frontend/marketing/job-approve.tsx');
  const statusSource = readRepoFile('frontend/marketing/job-status.tsx');

  assert.doesNotMatch(reviewItemSource, /No supporting artifacts were attached to this review item\./);
  assert.doesNotMatch(workspaceSource, /No attachments yet\./);
  assert.match(reviewItemSource, /Supporting materials/);
  assert.match(reviewItemSource, /What this decision does/);
  assert.match(workspaceSource, /Approve or request changes/);
  assert.match(workspaceSource, /Supporting materials/);
  assert.match(queueSource, /Ready now/);
  assert.match(approveSource, /Supporting materials/);
  assert.match(statusSource, /Campaign status/);
});
