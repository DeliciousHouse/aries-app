// PRD §20 invariant 11:
//   "Unapproved, speculative, malformed, secret-bearing, or cross-tenant data
//    must never enter durable memory."
//
// Operationalized as: scrubPreferenceLabelForHoncho redacts both PII patterns
// (email, name pairs) before any honcho write.  We test the function directly
// here so the redaction contract has a guardrail at the function boundary,
// independent of any single caller's discipline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubPreferenceLabelForHoncho } from '../../backend/memory/write-events';

test('email patterns are redacted from preference labels', () => {
  const out = scrubPreferenceLabelForHoncho('Sign up at brendan@example.com today');
  assert.match(out, /\[redacted_email\]/);
  assert.ok(!/brendan@example\.com/.test(out), 'raw email must not survive the scrubber');
});

test('multiple emails in a single label are all redacted', () => {
  const out = scrubPreferenceLabelForHoncho('a@b.com and c@d.org');
  assert.equal(out, '[redacted_email] and [redacted_email]');
});

test('FirstName LastName patterns are redacted (legacy v1 mode is the default)', () => {
  // Default mode (v2 flag unset) is the legacy broad redaction.  We assert on
  // the legacy behavior here because it is the documented current default
  // until ARIES_MEMORY_LABEL_REDACTION_V2 rollout completes.
  delete process.env.ARIES_MEMORY_LABEL_REDACTION_V2;
  const out = scrubPreferenceLabelForHoncho('Project lead: Casey Tanaka shipped it');
  assert.match(out, /\[redacted_name\]/);
});

test('null / undefined / non-string inputs do not throw', () => {
  assert.equal(scrubPreferenceLabelForHoncho(null), '');
  assert.equal(scrubPreferenceLabelForHoncho(undefined), '');
  assert.equal(scrubPreferenceLabelForHoncho(123 as unknown as string), '');
});
