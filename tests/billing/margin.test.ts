/**
 * AA-165 — margin per client.
 *
 * The whole point of this module is keeping "measured" and "assumed" apart, so
 * these pin the cases where a naive implementation would print a confident lie:
 *   - measured cost SUMs to 0 for an all-AI company (cost_cents is NULL on every
 *     AI row and SUM skips NULLs), which would read as 100% margin;
 *   - an unpriced client is unknown margin, not 100% loss;
 *   - a loss is never clamped to 0 — surfacing it is why this dashboard exists.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { projectMargin } from '@/backend/billing/margin';

test('an all-AI company does not report 100% margin off a zero-sum measured cost', () => {
  // The trap: Hermes reports no usage, so every cost_cents is NULL, SUM skips
  // NULLs and returns 0. Reading that as "cost = $0" makes every client look
  // perfectly profitable.
  const result = projectMargin({
    billedPriceCents: 29900,
    measuredCostCents: 0,
    usageReportedEvents: 0, // nothing reported — the 0 above is an artifact
    tasks: 500,
    costPerTaskCents: 2,
  });

  assert.equal(result.costBasis, 'modeled');
  assert.equal(result.measuredCostCents, null);
  assert.equal(result.modeledCostCents, 1000);
  assert.equal(result.costCents, 1000);
  assert.equal(result.marginCents, 28900);
  assert.equal(result.marginPercent, 97);
});

test('measured cost wins the moment any usage is actually reported', () => {
  const result = projectMargin({
    billedPriceCents: 29900,
    measuredCostCents: 4200,
    usageReportedEvents: 12,
    tasks: 500,
    costPerTaskCents: 2,
  });

  // No code change is needed when Hermes starts reporting — the basis flips.
  assert.equal(result.costBasis, 'measured');
  assert.equal(result.costCents, 4200);
  assert.equal(result.measuredCostCents, 4200);
  // The modeled figure is still returned for comparison, but is not the basis.
  assert.equal(result.modeledCostCents, 1000);
  assert.equal(result.marginCents, 25700);
});

test('a genuinely measured zero cost is honored, unlike an unreported one', () => {
  const result = projectMargin({
    billedPriceCents: 9900,
    measuredCostCents: 0,
    usageReportedEvents: 5, // something DID report, and it really was free
    tasks: 100,
    costPerTaskCents: 2,
  });

  assert.equal(result.costBasis, 'measured');
  assert.equal(result.costCents, 0);
  assert.equal(result.marginCents, 9900);
  assert.equal(result.marginPercent, 100);
});

test('an unpriced client is unknown margin, never 100% loss', () => {
  const result = projectMargin({
    billedPriceCents: null, // Enterprise with no negotiated price recorded
    measuredCostCents: null,
    usageReportedEvents: 0,
    tasks: 400,
    costPerTaskCents: 2,
  });

  assert.equal(result.billedPriceCents, null);
  assert.equal(result.costCents, 800);
  // price - cost is NOT computed against a phantom 0 price.
  assert.equal(result.marginCents, null);
  assert.equal(result.marginPercent, null);
});

test('with no cost basis at all, cost and margin are unavailable rather than zero', () => {
  const result = projectMargin({
    billedPriceCents: 29900,
    measuredCostCents: null,
    usageReportedEvents: 0,
    tasks: 500,
    costPerTaskCents: null, // no modeled rate configured
  });

  assert.equal(result.costBasis, 'unavailable');
  assert.equal(result.costCents, null);
  assert.equal(result.modeledCostCents, null);
  // Would otherwise print "$299.00 margin, 100%" for a client we know nothing about.
  assert.equal(result.marginCents, null);
  assert.equal(result.marginPercent, null);
});

test('a loss-making client is reported as a loss, not clamped to zero', () => {
  const result = projectMargin({
    billedPriceCents: 9900,
    measuredCostCents: null,
    usageReportedEvents: 0,
    tasks: 10_000,
    costPerTaskCents: 2,
  });

  assert.equal(result.costCents, 20_000);
  assert.equal(result.marginCents, -10_100);
  assert.equal(result.marginPercent, -102);
});

test('a zero-priced client yields no percentage instead of Infinity', () => {
  const result = projectMargin({
    billedPriceCents: 0,
    measuredCostCents: null,
    usageReportedEvents: 0,
    tasks: 100,
    costPerTaskCents: 2,
  });

  assert.equal(result.marginCents, -200);
  assert.equal(result.marginPercent, null);
});

test('fractional per-task rates do not leak floating-point noise onto the dashboard', () => {
  const result = projectMargin({
    billedPriceCents: 9900,
    measuredCostCents: null,
    usageReportedEvents: 0,
    tasks: 3,
    costPerTaskCents: 0.1,
  });

  assert.equal(result.costCents, 0.3);
  assert.equal(result.marginCents, 9899.7);
});
