import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeArtifactText } from '../backend/marketing/real-artifacts';

test('normalizeArtifactText strips "rerun with flag=true" CLI guidance from approval-facing copy', () => {
  const leaked =
    'Approval needed: marketing pipeline launch review for Acme Growth Testing Plan. ' +
    'Static assets: 6. Video assets: 8. ' +
    'Reply with approval and rerun with launch_approved=true to generate publish-ready assets.';
  const cleaned = normalizeArtifactText(leaked) || '';
  assert.doesNotMatch(cleaned, /launch_approved=true/i, `CLI flag leaked: ${cleaned}`);
  assert.doesNotMatch(cleaned, /\brerun\b/i, `"rerun" verb leaked: ${cleaned}`);
  assert.doesNotMatch(cleaned, /reply with approval/i, `CLI preamble leaked: ${cleaned}`);
  // The factual, user-relevant bits (asset counts) must survive.
  assert.match(cleaned, /Static assets: 6/);
  assert.match(cleaned, /Video assets: 8/);
});

test('normalizeArtifactText strips bare foo=true / --flag tokens', () => {
  assert.equal(
    normalizeArtifactText('Please pass launch_approved=true to continue.'),
    'Please pass to continue.',
  );
  const withLongFlag = normalizeArtifactText('Run the command --verbose=loud to see output.') || '';
  assert.doesNotMatch(withLongFlag, /--verbose/);

  const leadingLongFlag = normalizeArtifactText('--verbose=loud show the latest output.') || '';
  assert.doesNotMatch(leadingLongFlag, /--verbose/);
  assert.match(leadingLongFlag, /show the latest output\./i);
});

test('normalizeArtifactText leaves clean marketing copy untouched', () => {
  const copy = 'Handcrafted 14k gold jewelry designed for daily wear at accessible price points.';
  assert.equal(normalizeArtifactText(copy), copy);
});

test('normalizeArtifactText still strips the "rerun" variant with a hyphen or extra spaces', () => {
  const variants = [
    'Reply with approval and re-run with launch_approved=true to generate publish-ready assets.',
    'Reply with approval and retry with LAUNCH_APPROVED=TRUE to move forward.',
  ];
  for (const value of variants) {
    const cleaned = normalizeArtifactText(value) || '';
    assert.doesNotMatch(cleaned, /launch_approved\s*=\s*true/i, `variant leaked: ${value} -> ${cleaned}`);
    assert.doesNotMatch(cleaned, /\bre-?run\b/i);
    assert.doesNotMatch(cleaned, /\bretry\b/i);
  }
});
