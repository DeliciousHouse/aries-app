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

test('FirstName LastName patterns are redacted in the unset/legacy-v1 fallback', () => {
  // With ARIES_MEMORY_LABEL_REDACTION_V2 unset, the scrubber falls back to the
  // legacy v1 broad redaction. NOTE: the shipped container pins the flag ON
  // (docker-compose.yml `:-1`, i.e. v2) — so v2 is the live prod mode, not v1.
  // We assert the unset fallback here so the flag-absent code path (tests, any
  // env that omits the var) stays a safe PII redactor.
  delete process.env.ARIES_MEMORY_LABEL_REDACTION_V2;
  const out = scrubPreferenceLabelForHoncho('Project lead: Casey Tanaka shipped it');
  assert.match(out, /\[redacted_name\]/);
});

test('null / undefined / non-string inputs do not throw', () => {
  assert.equal(scrubPreferenceLabelForHoncho(null), '');
  assert.equal(scrubPreferenceLabelForHoncho(undefined), '');
  assert.equal(scrubPreferenceLabelForHoncho(123 as unknown as string), '');
});
