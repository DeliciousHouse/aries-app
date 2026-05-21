import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

const SOCIAL_CONTENT_EXECUTION_FILES = [
  'backend/marketing/execution-port.ts',
  'backend/marketing/ports/hermes.ts',
] as const;

const ACTIVE_SOCIAL_CONTENT_PATHS = [
  'backend/social-content/defaults.ts',
  'backend/social-content/payload.ts',
  'backend/social-content/runtime-state.ts',
  'backend/social-content/workflow-request.ts',
  'app/api/social-content/jobs/route.ts',
  'app/api/social-content/jobs/[jobId]/route.ts',
  'app/api/social-content/jobs/[jobId]/approve/route.ts',
  'app/social-content/new/page.tsx',
  'app/social-content/status/page.tsx',
  'app/social-content/review/page.tsx',
  'frontend/social-content/new-job.tsx',
  'lib/api/social-content.ts',
] as const;

const BANNED_SOCIAL_CONTENT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bWorkflowEnvelope\b/, label: 'WorkflowEnvelope' },
  { pattern: /\blegacy-openclaw\b/, label: 'legacy-openclaw' },
  { pattern: /\.lobster\b/, label: '.lobster workflow references' },
  { pattern: /\bmarketing_pipeline\b/, label: 'marketing_pipeline workflow key' },
  { pattern: /\bOPENCLAW_[A-Z0-9_]*\b/, label: 'OPENCLAW_* env dependencies' },
  { pattern: /\bGEMINI_API_KEY\b/, label: 'GEMINI_API_KEY dependency' },
];

test('social-content execution contract does not import WorkflowEnvelope', async () => {
  for (const file of SOCIAL_CONTENT_EXECUTION_FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(
      /\bWorkflowEnvelope\b/.test(source),
      false,
      `${file} must not reference WorkflowEnvelope`,
    );
  }
});

test('social-content execution contract does not import legacy-openclaw', async () => {
  for (const file of SOCIAL_CONTENT_EXECUTION_FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(
      source.includes('legacy-openclaw'),
      false,
      `${file} must not import legacy-openclaw`,
    );
  }
});

test('active social-content execution paths avoid legacy OpenClaw and Lobster dependencies', async () => {
  for (const file of ACTIVE_SOCIAL_CONTENT_PATHS) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const banned of BANNED_SOCIAL_CONTENT_PATTERNS) {
      assert.equal(
        banned.pattern.test(source),
        false,
        `${file} must not reference ${banned.label}`,
      );
    }
  }
});
