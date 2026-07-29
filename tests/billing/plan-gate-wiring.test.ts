/**
 * AA-163 — where the plan gate sits, and what the browser sees when it denies.
 *
 * The gate's placement is the part that cannot be checked by calling the helper:
 * it must run BEFORE `startSocialContentJob` mints a job id or writes a doc, or a
 * denied create would leave a half-built job behind. Asserted against the source
 * (the same approach as the repo's other source-assertion suites) because
 * driving the real orchestrator would need a DATA_ROOT, a brand kit and a
 * gateway — none of which this contract depends on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mapMarketingCreateFailure } from '@/lib/marketing-create-errors';

const orchestrator = fs.readFileSync(
  path.join(process.cwd(), 'backend', 'marketing', 'orchestrator.ts'),
  'utf8',
);

test('the gate runs before any job state is created', () => {
  const gateAt = orchestrator.indexOf('enforcePlanLimitOrThrow(input.tenantId)');
  const jobIdAt = orchestrator.indexOf('const jobId = makeSocialContentJobId()');

  assert.ok(gateAt > 0, 'startSocialContentJob must call the plan gate');
  assert.ok(jobIdAt > 0, 'job id minting moved — re-check where the gate sits');
  assert.ok(
    gateAt < jobIdAt,
    'the plan gate must run BEFORE the job id is minted, so a denied create leaves no partial state',
  );
  // Awaited, not fire-and-forget: a gate whose rejection is not awaited would
  // deny nothing and surface as an unhandled rejection.
  assert.match(orchestrator, /await enforcePlanLimitOrThrow\(input\.tenantId\)/);
});

test('startSocialContentJob is the single content-generation entry the gate covers', () => {
  // Every create path (dashboard forms, weekly trigger, onboarding, reel
  // companion) funnels through this one exported function, which is why one gate
  // call covers all customer-initiated AI work.
  assert.match(orchestrator, /export async function startSocialContentJob\(/);
});

test('a denied create maps to 402 with operator-actionable copy and no inner detail', () => {
  const mapped = mapMarketingCreateFailure('plan_limit_exceeded:starter:tasks');

  assert.ok(mapped, 'the plan-limit code must be mapped, not echoed raw');
  assert.equal(mapped.status, 402);
  assert.equal(mapped.error, 'plan_limit_exceeded');
  assert.match(mapped.message, /plan allowance/i);
  // The tier/metric detail stays server-side, like every other mapping here.
  assert.ok(!mapped.message.includes('starter'));
  assert.ok(!mapped.error.includes('tasks'));
});

test('unrelated create failures keep their existing mappings', () => {
  // Guards against the new branch swallowing codes it should not match.
  assert.equal(mapMarketingCreateFailure('brand_url_missing')?.status, 422);
  assert.equal(mapMarketingCreateFailure('missing_required_fields:brandUrl')?.status, 400);
  assert.equal(mapMarketingCreateFailure('some_unknown_code'), null);
});
