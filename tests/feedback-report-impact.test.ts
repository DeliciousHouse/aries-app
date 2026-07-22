import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PRIORITY,
  idempotencyLabel,
  impactLabel,
  priorityForImpact,
  reportLabels,
  resolveCustomerSlug,
  slugifyCustomer,
} from '../backend/feedback/impact';
import { FEEDBACK_IMPACTS } from '../lib/feedback/report-options';

test('all five impact values map to their SC-71 priority names', () => {
  assert.equal(priorityForImpact('p0_system_blocked'), 'P0 - Crit Sit');
  assert.equal(priorityForImpact('p1_account_blocked'), 'P1 - Critical');
  assert.equal(priorityForImpact('p2_feature_degraded'), 'P2 - High');
  assert.equal(priorityForImpact('p3_minor_glitch'), 'P3 - Minor');
  assert.equal(priorityForImpact('p4_question'), 'P4 - Informational');
});

test('unknown impact defaults to P2 - High', () => {
  assert.equal(priorityForImpact('p9_made_up'), DEFAULT_PRIORITY);
  assert.equal(priorityForImpact(''), DEFAULT_PRIORITY);
  // Object prototype names must not leak through the record lookup.
  assert.equal(priorityForImpact('constructor'), DEFAULT_PRIORITY);
  assert.equal(priorityForImpact('__proto__'), DEFAULT_PRIORITY);
});

test('every declared impact has a mapping (no silent fallback for real values)', () => {
  for (const impact of FEEDBACK_IMPACTS) {
    const priority = priorityForImpact(impact);
    assert.match(priority, /^P[0-4] - /);
  }
});

test('impact labels are the fixed impact-pN tokens', () => {
  assert.equal(impactLabel('p0_system_blocked'), 'impact-p0');
  assert.equal(impactLabel('p4_question'), 'impact-p4');
  assert.equal(impactLabel('garbage'), 'impact-p2');
});

test('customer slug: lowercase, strip, collapse, trim, cap 50', () => {
  assert.equal(slugifyCustomer('Sugar & Leather, Inc.'), 'sugar-leather-inc');
  assert.equal(slugifyCustomer('  --Weird---Name--  '), 'weird-name');
  const long = 'a'.repeat(80);
  assert.equal(slugifyCustomer(long).length, 50);
  // Cap must not leave a trailing dash when the cut lands on one.
  const dashAt50 = `${'a'.repeat(49)}-b`;
  assert.ok(!slugifyCustomer(dashAt50).endsWith('-'));
});

test('customer slug: unicode-only input falls through the source chain', () => {
  assert.equal(slugifyCustomer('日本語のみ'), '');
  assert.equal(
    resolveCustomerSlug({ tenantSlug: '日本語のみ', tenantName: 'ゆにこーど', tenantId: '42' }),
    '42',
  );
  assert.equal(
    resolveCustomerSlug({ tenantSlug: null, tenantName: null, tenantId: null }),
    'unknown',
  );
  assert.equal(
    resolveCustomerSlug({ tenantSlug: 'acme-co', tenantName: 'ignored', tenantId: '7' }),
    'acme-co',
  );
});

test('report labels carry triage, customer, product-unique idempotency, and impact', () => {
  const labels = reportLabels('123e4567-e89b-42d3-a456-426614174000', 'acme', 'p1_account_blocked');
  assert.deepEqual(labels, [
    'customer-incident',
    'customer-acme',
    'aries-sub-123e4567-e89b-42d3-a456-426614174000',
    'impact-p1',
  ]);
  // The idempotency prefix must be Aries-unique (Sequence uses crm-sub-).
  assert.ok(idempotencyLabel('x').startsWith('aries-sub-'));
  assert.ok(!idempotencyLabel('x').startsWith('crm-sub-'));
});

test('an empty customer slug never produces a bare "customer-" label', () => {
  const labels = reportLabels('id-1', '', 'p4_question');
  assert.ok(labels.includes('customer-unknown'));
});

test('anonymous reports receive a dedicated Jira triage label', () => {
  const labels = reportLabels('id-anon', 'anonymous', 'p2_feature_degraded', 'anonymous');
  assert.ok(labels.includes('anonymous-feedback'));
});
