/**
 * AA-218 — the tenant-scopable native-content flag.
 *
 * WHY THIS FLAG IS SEPARATE FROM ARIES_ANY_PLATFORM_PUBLISH_ENABLED.
 *
 * When AA-218 was rebuilt onto master (#974, after #973 was auto-closed by its
 * base branch being deleted) the two concerns were folded into one flag. They
 * are not one concern:
 *
 *   - ANY_PLATFORM decides ELIGIBILITY — does a non-Meta connection count as a
 *     publishable channel, so the tenant gets a week of content at all.
 *   - NATIVE_CONTENT decides VOICE — are the strategy/production/publish PROMPTS
 *     told the tenant's real platforms.
 *
 * Folding them together means you cannot canary the prompt change. Prompts are
 * built per run from one global process env, so a fleet-wide `true` rewrites a
 * live tenant's prompts in the same cycle as the canary tenant's. The allowlist
 * form is what makes a canary genuinely dark for everyone else, so the tests
 * that matter most here are the ones pinning "listed tenant on, everyone else
 * off" and "no tenant named => off".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAnyPlatformPublishEnabled,
  isPlatformNativeContentEnabled,
} from '../backend/integrations/providers/integration-config';
import { buildHermesStageInstructions } from '../backend/marketing/ports/hermes';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '../backend/social-content/defaults';

const env = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: value }) as NodeJS.ProcessEnv;

test('unset is OFF, for a named tenant and for no tenant alike', () => {
  assert.equal(isPlatformNativeContentEnabled(env(), 70), false);
  assert.equal(isPlatformNativeContentEnabled(env(), undefined), false);
  assert.equal(isPlatformNativeContentEnabled(env(''), 70), false);
  assert.equal(isPlatformNativeContentEnabled(env('   '), 70), false);
});

test('the four falsy tokens are OFF and are never parsed as a tenant list', () => {
  for (const token of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
    assert.equal(isPlatformNativeContentEnabled(env(token), 70), false, `token ${token}`);
  }
});

test('the four truthy tokens are fleet-wide — on even with no tenant named', () => {
  for (const token of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
    assert.equal(isPlatformNativeContentEnabled(env(token), 70), true, `token ${token}`);
    assert.equal(isPlatformNativeContentEnabled(env(token), undefined), true, `token ${token} / no tenant`);
  }
});

test('a CSV allowlist is ON for listed tenants and OFF for everyone else', () => {
  const allow = env('70,71');
  assert.equal(isPlatformNativeContentEnabled(allow, 70), true);
  assert.equal(isPlatformNativeContentEnabled(allow, 71), true);
  // The canary guarantee: the live tenant must stay dark.
  assert.equal(isPlatformNativeContentEnabled(allow, 15), false);
  assert.equal(isPlatformNativeContentEnabled(allow, 69), false);
});

test('an allowlist with no tenant named is OFF — never "on because the var is non-empty"', () => {
  assert.equal(isPlatformNativeContentEnabled(env('70'), undefined), false);
  assert.equal(isPlatformNativeContentEnabled(env('70'), null), false);
});

test('tenant ids normalize across number, string and padded string', () => {
  const allow = env(' 70 , 71 ');
  assert.equal(isPlatformNativeContentEnabled(allow, 70), true);
  assert.equal(isPlatformNativeContentEnabled(allow, '70'), true);
  assert.equal(isPlatformNativeContentEnabled(allow, ' 70 '), true);
});

test('non-numeric and non-positive tenant tokens never match', () => {
  const allow = env('70');
  for (const bad of ['', 'seventy', '7 0', '-70', '0', '70abc', 'NaN']) {
    assert.equal(isPlatformNativeContentEnabled(allow, bad), false, `tenant ${bad}`);
  }
  assert.equal(isPlatformNativeContentEnabled(allow, 0), false);
  assert.equal(isPlatformNativeContentEnabled(allow, -70), false);
  assert.equal(isPlatformNativeContentEnabled(allow, 70.5), false);
});

test('garbage in the flag does not silently enable anyone', () => {
  for (const junk of ['enabled', 'all', 'meta', 'true-ish', ',', ',,']) {
    assert.equal(isPlatformNativeContentEnabled(env(junk), 70), false, `junk ${junk}`);
  }
});

test('DOCUMENTED AMBIGUITY: bare `1` is fleet-wide, so tenant 1 cannot be allowlisted alone', () => {
  // `1` wins as the repo's canonical truthy token. Tenant 1 is therefore on —
  // but so is every other tenant, which is the point of the warning.
  assert.equal(isPlatformNativeContentEnabled(env('1'), 1), true);
  assert.equal(isPlatformNativeContentEnabled(env('1'), 999), true);
  // Listing it alongside another id gives the scoped behaviour.
  assert.equal(isPlatformNativeContentEnabled(env('1,70'), 1), true);
  assert.equal(isPlatformNativeContentEnabled(env('1,70'), 999), false);
});

test('the two flags are independent — neither reads the other\'s variable', () => {
  const anyOnly = { ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1' } as unknown as NodeJS.ProcessEnv;
  assert.equal(isAnyPlatformPublishEnabled(anyOnly), true);
  assert.equal(isPlatformNativeContentEnabled(anyOnly, 70), false);

  const nativeOnly = { ARIES_PLATFORM_NATIVE_CONTENT_ENABLED: '1' } as unknown as NodeJS.ProcessEnv;
  assert.equal(isAnyPlatformPublishEnabled(nativeOnly), false);
  assert.equal(isPlatformNativeContentEnabled(nativeOnly, 70), true);
});

test('the native contract reaches stage instructions only when the flag says so', () => {
  const marker = 'PLATFORM-NATIVE CONTENT CONTRACT';
  for (const stage of ['strategy', 'production', 'publish'] as const) {
    const off = buildHermesStageInstructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, stage, null, false);
    const on = buildHermesStageInstructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, stage, null, true);
    assert.equal(off.includes(marker), false, `${stage} must be unchanged with the flag off`);
    assert.equal(on.includes(marker), true, `${stage} must carry the contract with the flag on`);
    // Flag-on is strictly additive: the legacy instructions survive verbatim.
    assert.ok(on.startsWith(off), `${stage} flag-on must extend, not rewrite, the legacy prompt`);
  }
});

test('research never carries the native contract, on or off', () => {
  const marker = 'PLATFORM-NATIVE CONTENT CONTRACT';
  const on = buildHermesStageInstructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, 'research', null, true);
  assert.equal(on.includes(marker), false);
});
