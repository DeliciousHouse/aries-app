/**
 * Regression coverage for #630: X (Twitter) as a Composio-connectable platform
 * gated by ARIES_X_ENABLED.
 *
 * Failure modes locked:
 *  - Flag OFF: 'x' absent from connectablePlatforms, platformOr400 returns 400
 *    unsupported_platform, list endpoint returns 7 slots (no x).
 *  - Flag ON:  'x' present in connectablePlatforms, platformOr400 passes through,
 *    list endpoint returns 8 slots including x.
 *  - Config: TOOLKIT_SLUG.x === 'twitter'; COMPOSIO_X_AUTH_CONFIG_ID read correctly.
 *  - Regression guard: all 7 original platforms remain byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectablePlatforms,
  isXEnabled,
  composioAuthConfigId,
  isIntegrationPlatform,
} from '@/backend/integrations/providers';
import { TOOLKIT_SLUG } from '@/backend/integrations/composio/composio-config';
import {
  handleComposioConnect,
  handleComposioList,
} from '@/app/api/integrations/composio/handlers';
import type { TenantRole } from '@/lib/tenant-context';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal NodeJS.ProcessEnv from a plain object. */
const mkEnv = (o: Record<string, string>): NodeJS.ProcessEnv =>
  o as unknown as NodeJS.ProcessEnv;

/**
 * Set/restore a subset of process.env keys around an async callback.
 * Pass `undefined` as the value to delete the key during the callback.
 */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return fn().finally(() => {
    for (const [k, original] of prev) {
      if (original === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original;
      }
    }
  });
}

/**
 * Fake tenant loader — matches the TenantContextLoader signature used by the
 * handlers. Composio tests in this file do not exercise auth logic, so any
 * valid tenant shape is sufficient.
 */
const tenantLoader = async () => ({
  userId: 'user_1',
  tenantId: '1',
  tenantSlug: 'test-tenant',
  role: 'tenant_admin' as TenantRole,
});

// ── 1. Dormancy: flag OFF / unset ────────────────────────────────────────────

test('connectablePlatforms flag-OFF: does not include x', () => {
  const platforms = connectablePlatforms(mkEnv({}));
  assert.ok(
    !platforms.includes('x'),
    "'x' must not be in connectablePlatforms when ARIES_X_ENABLED is unset",
  );
  assert.equal(platforms.length, 7, 'exactly 7 platforms when flag is off');
});

test('isXEnabled: returns false when ARIES_X_ENABLED is unset', () => {
  assert.equal(isXEnabled(mkEnv({})), false);
});

test('isXEnabled: returns false for non-truthy values', () => {
  for (const v of ['0', 'false', 'no', 'off', '']) {
    assert.equal(
      isXEnabled(mkEnv({ ARIES_X_ENABLED: v })),
      false,
      `isXEnabled must be false for ARIES_X_ENABLED=${JSON.stringify(v)}`,
    );
  }
});

test('handleComposioConnect x flag-OFF: returns 400 unsupported_platform', async () => {
  // platformOr400 is called before tenant loading; no loader needed for flag-OFF.
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const req = new Request(
      'https://aries.example.com/api/integrations/composio/x/connect',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
    );
    const response = await handleComposioConnect(req, 'x');
    const body = (await response.json()) as { reason: string; message: string };
    assert.equal(response.status, 400);
    assert.equal(body.reason, 'unsupported_platform');
  });
});

test('handleComposioList flag-OFF: response connections do not include x', async () => {
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string }>;
    };
    const platforms = body.connections.map((c) => c.platform);
    assert.ok(
      !platforms.includes('x'),
      "x must not appear in connection list when ARIES_X_ENABLED is off",
    );
    assert.equal(platforms.length, 7, '7 connection slots when flag is off');
  });
});

// ── 2. Fix proof: flag ON ────────────────────────────────────────────────────

test('connectablePlatforms flag-ON: includes x (8 total)', () => {
  const platforms = connectablePlatforms(mkEnv({ ARIES_X_ENABLED: '1' }));
  assert.ok(
    platforms.includes('x'),
    "'x' must be in connectablePlatforms when ARIES_X_ENABLED=1",
  );
  assert.equal(platforms.length, 8, '8 platforms when flag is on');
});

test('isXEnabled: true for all canonical truthy values', () => {
  for (const v of ['1', 'true', 'yes', 'on']) {
    assert.equal(
      isXEnabled(mkEnv({ ARIES_X_ENABLED: v })),
      true,
      `isXEnabled must be true for ARIES_X_ENABLED=${v}`,
    );
  }
});

test('handleComposioConnect x flag-ON: passes the platform gate (no 400 unsupported_platform)', async () => {
  // With the flag ON, platformOr400 lets 'x' through. Without Composio configured
  // (COMPOSIO_ENABLED unset), the handler returns 409 composio_disabled — but the
  // point is it must NOT return 400 unsupported_platform.
  await withEnv({ ARIES_X_ENABLED: '1' }, async () => {
    const req = new Request(
      'https://aries.example.com/api/integrations/composio/x/connect',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
    );
    const response = await handleComposioConnect(req, 'x', tenantLoader);
    const body = (await response.json()) as { reason?: string };
    assert.notEqual(
      response.status,
      400,
      'status must not be 400 when x is enabled',
    );
    assert.notEqual(
      body.reason,
      'unsupported_platform',
      'reason must not be unsupported_platform when x is enabled',
    );
  });
});

test('handleComposioList flag-ON: response connections include x (8 slots)', async () => {
  await withEnv({ ARIES_X_ENABLED: '1' }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string }>;
    };
    const platforms = body.connections.map((c) => c.platform);
    assert.ok(
      platforms.includes('x'),
      "x must appear in connection list when ARIES_X_ENABLED=1",
    );
    assert.equal(platforms.length, 8, '8 connection slots when flag is on');
  });
});

// ── 3. Config wiring ─────────────────────────────────────────────────────────

test('TOOLKIT_SLUG.x === twitter (Composio toolkit name for X)', () => {
  assert.equal(TOOLKIT_SLUG.x, 'twitter');
});

test('composioAuthConfigId x: reads COMPOSIO_X_AUTH_CONFIG_ID', () => {
  assert.equal(
    composioAuthConfigId('x', mkEnv({ COMPOSIO_X_AUTH_CONFIG_ID: 'ac_x_test' })),
    'ac_x_test',
  );
});

test('composioAuthConfigId x: returns null when neither x-specific nor default key is set', () => {
  // Mirror existing platform behavior: unset → null.
  assert.equal(composioAuthConfigId('x', mkEnv({})), null);
  // Symmetry assertion: facebook behaves identically when unset.
  assert.equal(composioAuthConfigId('facebook', mkEnv({})), null);
});

test('composioAuthConfigId x: falls back to COMPOSIO_DEFAULT_AUTH_CONFIG_ID when x-specific key absent', () => {
  assert.equal(
    composioAuthConfigId('x', mkEnv({ COMPOSIO_DEFAULT_AUTH_CONFIG_ID: 'ac_default' })),
    'ac_default',
  );
});

// ── 4. Regression guard: the other 7 platforms remain byte-identical ─────────

test('connectablePlatforms flag-OFF: all 7 original platforms still present', () => {
  const off = connectablePlatforms(mkEnv({}));
  const original7 = [
    'facebook',
    'instagram',
    'meta_ads',
    'tiktok',
    'youtube',
    'linkedin',
    'reddit',
  ] as const;
  for (const p of original7) {
    assert.ok(off.includes(p), `${p} must be present with flag OFF`);
  }
});

test('connectablePlatforms flag-ON: all 8 platforms present (original 7 + x)', () => {
  const on = connectablePlatforms(mkEnv({ ARIES_X_ENABLED: '1' }));
  const all8 = [
    'facebook',
    'instagram',
    'meta_ads',
    'tiktok',
    'youtube',
    'linkedin',
    'reddit',
    'x',
  ] as const;
  for (const p of all8) {
    assert.ok(on.includes(p), `${p} must be present with flag ON`);
  }
});

test('isIntegrationPlatform x: always true regardless of flag (pure type guard)', () => {
  // The type guard checks INTEGRATION_PLATFORMS array membership, not the env flag.
  // The dormancy chokepoint is connectablePlatforms(), not this predicate.
  assert.equal(isIntegrationPlatform('x'), true);
});

test('isIntegrationPlatform: unknown value is false (guard soundness)', () => {
  assert.equal(isIntegrationPlatform('unknown_platform'), false);
  assert.equal(isIntegrationPlatform(''), false);
  assert.equal(isIntegrationPlatform('twitter'), false, "'twitter' is a toolkit slug, not an Aries platform key");
});
