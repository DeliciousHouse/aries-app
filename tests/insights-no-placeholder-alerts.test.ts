/**
 * tests/insights-no-placeholder-alerts.test.ts
 *
 * S1-7 / AA-86 — make the insights UI honest. Source-level scan (these are
 * client .tsx components, so a source scan is the right surface):
 *  - NO placeholder alert() anywhere under frontend/insights/.
 *  - The Conversations Reply button is kept VISIBLE but disabled with a
 *    "Reply ships soon" tooltip (S5-2 just flips disabled off) — NOT removed.
 *  - The demographics empty-state copy no longer tells a (possibly connected)
 *    tenant to "connect" anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSIGHTS_DIR = fileURLToPath(new URL('../frontend/insights/', import.meta.url));

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => path.join(dir, f));
}

function read(rel: string): string {
  return fs.readFileSync(path.join(INSIGHTS_DIR, rel), 'utf8');
}

test('no placeholder alert() remains anywhere under frontend/insights/', () => {
  const offenders: string[] = [];
  for (const file of tsxFiles(INSIGHTS_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/\balert\s*\(/.test(src)) offenders.push(path.basename(file));
  }
  assert.deepEqual(offenders, [], `alert() must be gone; still present in: ${offenders.join(', ')}`);
});

// AA-111 (S5-2) wired this button up for real, so the original assertion — that
// Reply is hardcoded `disabled` with a "Reply ships soon" tooltip — no longer
// describes intended behaviour and was replaced rather than deleted. The intent
// worth keeping is unchanged: the control must still EXIST (not be quietly
// removed) and must be backed by the real endpoint rather than a placeholder.
// Behavioural coverage of the wiring lives in
// tests/insights-conversations-reply-ui.test.ts.
test('Conversations Reply button is present and wired to the real reply endpoint', () => {
  const src = read('ConversationsSection.tsx');

  assert.match(src, /label="Reply"/, 'the Reply button must NOT be removed');

  // Gated on the rollout flag, not permanently disabled.
  assert.match(
    src,
    /disabled=\{!nativeReplyEnabled\}/,
    'Reply must be gated on nativeReplyEnabled, not hardcoded disabled',
  );

  // Backed by the shipped endpoint — no placeholder, no fake success.
  assert.match(
    src,
    /fetch\(`\/api\/insights\/comments\/\$\{item\.id\}\/reply`/,
    'Reply must POST to the real comment reply endpoint',
  );

  // The ships-soon copy survives only as the flag-off tooltip.
  assert.match(src, /Reply ships soon/, 'flag-off state still explains why Reply is unavailable');
});

test('demographics empty state no longer tells the user to connect', () => {
  const src = read('AudienceSection.tsx');
  const demoLine = src.split('\n').find((l) => l.includes('demographics coming soon') || l.includes('Audience demographics'));
  assert.ok(demoLine, 'expected a demographics coming-soon stub line');
  assert.doesNotMatch(demoLine!, /connect/i, 'demographics copy must not claim the user needs to connect');
});
