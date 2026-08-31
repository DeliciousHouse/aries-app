import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOTS = ['backend', 'lib'];

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

test('every direct Hermes run submission is execution-log instrumented', () => {
  const submissionFiles = ROOTS
    .flatMap(sourceFiles)
    .filter((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      return source.includes('/v1/runs') && /method:\s*['"]POST['"]/.test(source);
    })
    .map((filePath) => filePath.replaceAll('\\', '/'))
    .sort();

  assert.deepEqual(submissionFiles, [
    'backend/execution/providers/hermes.ts',
    'backend/insights/sync/classify-comments.ts',
    'backend/marketing/brand-kit-enrich.ts',
    'backend/marketing/ports/hermes.ts',
    'backend/marketing/posting-time-advisor.ts',
    'lib/feedback/severity-classifier.ts',
  ]);

  for (const filePath of submissionFiles) {
    const source = readFileSync(filePath, 'utf8');
    assert.match(
      source,
      /(?:withTaskExecutionLog|recordTaskExecution)/,
      `${filePath} submits Hermes runs without execution logging`,
    );
  }

  const researchWebhook = readFileSync('backend/memory/hermes-dispatch.ts', 'utf8');
  assert.match(researchWebhook, /HERMES_RESEARCH_WEBHOOK_URL/);
  assert.match(researchWebhook, /withTaskExecutionLog/);
});
