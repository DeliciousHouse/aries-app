import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { repairLegacyMarketingText } from '../backend/marketing/brand-kit';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const workspaceStoreSource = readFileSync(
  path.join(PROJECT_ROOT, 'backend', 'marketing', 'workspace-store.ts'),
  'utf8',
);
const businessProfileSource = readFileSync(
  path.join(PROJECT_ROOT, 'backend', 'tenant', 'business-profile.ts'),
  'utf8',
);

// Regression: ISSUE-QA-004 — stale persisted marketing text leaked `& x27;`
// entity artifacts and space-before-punctuation glitches into live business
// profile and campaign workspace screens.
// Found by /qa on 2026-04-23
// Report: .gstack/qa-reports/qa-report-aries-sugarandleather-com-2026-04-23.md

test('repairLegacyMarketingText fixes mangled entity artifacts and orphan punctuation', () => {
  assert.equal(
    repairLegacyMarketingText('Inspiring the world& x27;s athletes, Nike delivers innovative , experiences and services.'),
    "Inspiring the world's athletes, Nike delivers innovative, experiences and services.",
  );
  assert.equal(
    repairLegacyMarketingText('Line one\nKeep & x27;em moving'),
    "Line one\nKeep 'em moving",
  );
  assert.equal(repairLegacyMarketingText("Already clean"), 'Already clean');
});

test('workspace-store normalizes stale brief text through the shared repair helper', () => {
  assert.match(workspaceStoreSource, /import \{ repairLegacyMarketingText \} from '@\/backend\/marketing\/brand-kit';/);
  for (const field of ['businessName', 'businessType', 'approverName', 'goal', 'offer', 'brandVoice', 'styleVibe', 'mustUseCopy', 'mustAvoidAesthetics', 'notes']) {
    assert.match(
      workspaceStoreSource,
      new RegExp(`${field}: repairLegacyMarketingText\\(`),
      `normalizeCampaignBrief should repair stale ${field} text on read`,
    );
  }
});

test('business-profile view repairs stale display text before returning API data', () => {
  assert.match(businessProfileSource, /import \{[\s\S]*repairLegacyMarketingText,[\s\S]*\} from '@\/backend\/marketing\/brand-kit';/);
  assert.match(businessProfileSource, /const effectiveOffer = repairLegacyMarketingText\(/);
  assert.match(businessProfileSource, /const effectiveBrandVoice = repairLegacyMarketingText\(/);
  assert.match(businessProfileSource, /const effectiveStyleVibe = repairLegacyMarketingText\(/);
  assert.match(businessProfileSource, /const effectiveNotes = repairLegacyMarketingText\(/);
});
