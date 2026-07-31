/**
 * AA-163 — tiered plan rate cards.
 *
 * Pins the shape a Product Manager configures against, and the two boundaries
 * that keep the card from turning into a billing engine:
 *   - four tiers, exactly the ones the AC names;
 *   - a NULL allowance is UNLIMITED, never a 0 ceiling that denies everything —
 *     this is how Enterprise/Custom is expressed;
 *   - the price is declarative: nothing in the module multiplies by it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_PLAN_TIER,
  DEFAULT_RATE_CARDS,
  PLAN_TIERS,
  isPlanTier,
  parseAllowance,
  parseRateCents,
  rateCardForTier,
  resolveBilledPriceCents,
} from '@/backend/billing/rate-cards';
import { parseOverride } from '@/scripts/billing/set-company-plan';

test('exactly the four tiers the AC names, entry tier first', () => {
  assert.deepEqual([...PLAN_TIERS], ['starter', 'growth', 'scale', 'enterprise']);
  assert.equal(DEFAULT_PLAN_TIER, 'starter');
  for (const tier of PLAN_TIERS) {
    assert.equal(DEFAULT_RATE_CARDS[tier].tier, tier);
    assert.ok(DEFAULT_RATE_CARDS[tier].displayName.length > 0);
  }
  // The AC's Small/Medium/Large/Custom vocabulary is carried in the display names
  // so the operator-facing surface matches the ticket.
  assert.match(DEFAULT_RATE_CARDS.starter.displayName, /Small/);
  assert.match(DEFAULT_RATE_CARDS.growth.displayName, /Medium/);
  assert.match(DEFAULT_RATE_CARDS.scale.displayName, /Large/);
  assert.match(DEFAULT_RATE_CARDS.enterprise.displayName, /Custom/);
});

test('allowances increase with tier, and Enterprise is unlimited by default', () => {
  const starter = DEFAULT_RATE_CARDS.starter.monthlyTaskAllowance!;
  const growth = DEFAULT_RATE_CARDS.growth.monthlyTaskAllowance!;
  const scale = DEFAULT_RATE_CARDS.scale.monthlyTaskAllowance!;
  assert.ok(starter < growth && growth < scale);
  // Custom/Enterprise is this tier plus per-company overrides, not a bespoke path.
  assert.equal(DEFAULT_RATE_CARDS.enterprise.monthlyTaskAllowance, null);
  assert.equal(DEFAULT_RATE_CARDS.enterprise.monthlyTokenAllowance, null);
});

test('an unrecognized tier falls back instead of throwing', () => {
  // A stray tier value in one row must not take down job creation for that
  // company; it degrades to the entry card.
  assert.equal(rateCardForTier('nope').tier, DEFAULT_PLAN_TIER);
  assert.equal(rateCardForTier(null).tier, DEFAULT_PLAN_TIER);
  assert.equal(rateCardForTier('growth').tier, 'growth');
  assert.equal(isPlanTier('growth'), true);
  assert.equal(isPlanTier('gold'), false);
});

test('allowance parsing treats anything non-numeric as unlimited, never as zero', () => {
  // BIGINT arrives from pg as a string.
  assert.equal(parseAllowance('5000'), 5000);
  assert.equal(parseAllowance(5000), 5000);
  assert.equal(parseAllowance(5000n), 5000);
  assert.equal(parseAllowance(0), 0); // an explicit 0 IS a real ceiling
  // A 0 ceiling from garbage would deny every request for that company.
  assert.equal(parseAllowance(null), null);
  assert.equal(parseAllowance(undefined), null);
  assert.equal(parseAllowance('1e4'), null);
  assert.equal(parseAllowance('12garbage'), null);
  assert.equal(parseAllowance(-5), null);
});

test('the CLI override argument is tri-state so a negotiated ceiling can be undone', () => {
  assert.deepEqual(parseOverride(undefined, 'tasks'), { provided: false, value: null });
  assert.deepEqual(parseOverride('100000', 'tasks'), { provided: true, value: 100000 });
  assert.deepEqual(parseOverride('none', 'tasks'), { provided: true, value: null });
  assert.deepEqual(parseOverride('unlimited', 'tasks'), { provided: true, value: null });
  assert.throws(() => parseOverride('lots', 'tasks'), /non-negative integer/);
  assert.throws(() => parseOverride(true, 'tasks'), /needs a value/);
});

test('the rate card stays declarative — no cost is computed from it', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'backend', 'billing', 'usage-entitlement.ts'),
    'utf8',
  );
  // The gate reads allowances only. If it ever reads the price, this ticket has
  // quietly become a billing engine and needs the decision reopened.
  assert.ok(!source.includes('costPerMillionTokens'));
  assert.ok(!source.includes('cost_per_million_tokens_cents'));
  // AA-165 added a real subscription price and a modeled cost rate for the
  // INTERNAL margin dashboard. The gate must not read those either: a price is
  // not a ceiling, and a modeled cost must never decide whether work may run.
  assert.ok(!source.includes('monthly_price_cents'));
  assert.ok(!source.includes('cost_per_task_cents'));
});

test('measured COGS is never synthesized from the rate card', () => {
  // AA-162 defined daily_company_usage.total_cogs_cents as sum(cost_cents) from
  // the raw log, and AA-165 introduced a configurable price + modeled cost rate
  // right next to it. If the view ever starts multiplying a rate card, "COGS"
  // silently stops meaning "what we actually spent" — the exact confusion
  // backend/billing/margin.ts exists to keep visible.
  for (const file of [
    path.join(process.cwd(), 'migrations', '20260728000000_daily_company_usage.sql'),
    path.join(process.cwd(), 'backend', 'telemetry', 'usage-rollups.ts'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!source.includes('plan_rate_cards'), file);
    assert.ok(!source.includes('cost_per_task_cents'), file);
    assert.ok(!source.includes('monthly_price_cents'), file);
  }
});

test('a NUMERIC price parses without losing precision, and unknown stays unknown', () => {
  // pg returns NUMERIC as a string. A null price is "not configured" — turning
  // it into 0 would make an unpriced client look like 100% loss (or 100% margin)
  // on the finance dashboard.
  assert.equal(parseRateCents('29900.0000'), 29900);
  assert.equal(parseRateCents('2.000000'), 2);
  assert.equal(parseRateCents('0.5'), 0.5);
  assert.equal(parseRateCents(9900), 9900);
  assert.equal(parseRateCents(null), null);
  assert.equal(parseRateCents(undefined), null);
  assert.equal(parseRateCents(''), null);
  assert.equal(parseRateCents('1e4'), null);
  assert.equal(parseRateCents('12garbage'), null);
  assert.equal(parseRateCents(-5), null);
});

test('a negotiated per-company price beats the tier card, and unpriced stays null', () => {
  assert.equal(
    resolveBilledPriceCents(
      { monthly_price_cents_override: '250000.0000', monthly_price_cents: '99900.0000' },
      'scale',
    ),
    250_000,
  );
  assert.equal(resolveBilledPriceCents({ monthly_price_cents: '9900.0000' }, 'starter'), 9900);
  // Enterprise with no negotiated price recorded: unknown, never free.
  assert.equal(
    resolveBilledPriceCents({ monthly_price_cents_override: null, monthly_price_cents: null }, 'enterprise'),
    null,
  );
  // No subscription row at all falls back to the tier's shipped card.
  assert.equal(resolveBilledPriceCents(undefined, 'growth'), 29900);
});
