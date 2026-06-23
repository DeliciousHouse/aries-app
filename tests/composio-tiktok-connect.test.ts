/**
 * Regression coverage for #690: TikTok gated out of Composio connect by
 * ARIES_TIKTOK_ENABLED (default OFF).
 *
 * TikTok cannot complete the 5-gate golden journey today: Composio has no
 * TikTok comments/reply actions, public publish is audit-gated, and analytics
 * is account-level only. The platform is fully dormant until those gaps close.
 *
 * Failure modes locked:
 *  - Flag OFF: 'tiktok' absent from connectablePlatforms, platformOr400 returns
 *    400 unsupported_platform, list endpoint returns 6 slots (no x, no tiktok).
 *  - Flag ON:  'tiktok' present in connectablePlatforms, platformOr400 passes
 *    through, list endpoint returns 7 slots including tiktok (x still dormant).
 *  - Auth-config #690: tiktok must NOT inherit COMPOSIO_DEFAULT_AUTH_CONFIG_ID
 *    (a Meta-family config); explicit COMPOSIO_TIKTOK_AUTH_CONFIG_ID still works.
 *  - metaPlatform #690 defense-in-depth: metaPlatform('tiktok') must throw so
 *    a dormant tiktok post can never silently dispatch to facebook.
 *  - Regression guard: the 6 still-connectable platforms remain byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectablePlatforms,
  isTikTokEnabled,
  composioAuthConfigId,
  isIntegrationPlatform,
} from '@/backend/integrations/providers';
import { TOOLKIT_SLUG } from '@/backend/integrations/composio/composio-config';
import {
  handleComposioConnect,
  handleComposioList,
} from '@/app/api/integrations/composio/handlers';
import { metaPlatform } from '@/backend/integrations/publish-dispatch';
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

test('connectablePlatforms flag-OFF: does not include tiktok', () => {
  const platforms = connectablePlatforms(mkEnv({}));
  assert.ok(
    !platforms.includes('tiktok'),
    "'tiktok' must not be in connectablePlatforms when ARIES_TIKTOK_ENABLED is unset",
  );
  assert.equal(platforms.length, 6, 'exactly 6 platforms when flag is off (no x, no tiktok)');
});

test('isTikTokEnabled: returns false when ARIES_TIKTOK_ENABLED is unset', () => {
  assert.equal(isTikTokEnabled(mkEnv({})), false);
});

test('isTikTokEnabled: returns false for non-truthy values', () => {
  for (const v of ['0', 'false', 'no', 'off', '']) {
    assert.equal(
      isTikTokEnabled(mkEnv({ ARIES_TIKTOK_ENABLED: v })),
      false,
      `isTikTokEnabled must be false for ARIES_TIKTOK_ENABLED=${JSON.stringify(v)}`,
    );
  }
});

test('handleComposioConnect tiktok flag-OFF: returns 400 unsupported_platform', async () => {
  // platformOr400 is called before tenant loading; no loader needed for flag-OFF.
  await withEnv({ ARIES_TIKTOK_ENABLED: undefined }, async () => {
    const req = new Request(
      'https://aries.example.com/api/integrations/composio/tiktok/connect',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
    );
    const response = await handleComposioConnect(req, 'tiktok');
    const body = (await response.json()) as { reason: string; message: string };
    assert.equal(response.status, 400);
    assert.equal(body.reason, 'unsupported_platform');
  });
});

test('handleComposioList flag-OFF: response connections do not include tiktok', async () => {
  await withEnv({ ARIES_TIKTOK_ENABLED: undefined }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string }>;
    };
    const platforms = body.connections.map((c) => c.platform);
    assert.ok(
      !platforms.includes('tiktok'),
      "tiktok must not appear in connection list when ARIES_TIKTOK_ENABLED is off",
    );
    assert.equal(platforms.length, 6, '6 connection slots when flag is off (no x, no tiktok)');
  });
});

// ── 2. Fix proof: flag ON ────────────────────────────────────────────────────

test('connectablePlatforms flag-ON: includes tiktok (7 total, x still dormant)', () => {
  // Only ARIES_TIKTOK_ENABLED is set; X stays off → 7 platforms total.
  const platforms = connectablePlatforms(mkEnv({ ARIES_TIKTOK_ENABLED: '1' }));
  assert.ok(
    platforms.includes('tiktok'),
    "'tiktok' must be in connectablePlatforms when ARIES_TIKTOK_ENABLED=1",
  );
  assert.equal(platforms.length, 7, '7 platforms when flag is on (x still dormant)');
});

test('isTikTokEnabled: true for all canonical truthy values', () => {
  for (const v of ['1', 'true', 'yes', 'on']) {
    assert.equal(
      isTikTokEnabled(mkEnv({ ARIES_TIKTOK_ENABLED: v })),
      true,
      `isTikTokEnabled must be true for ARIES_TIKTOK_ENABLED=${v}`,
    );
  }
});

test('handleComposioConnect tiktok flag-ON: passes the platform gate (no 400 unsupported_platform)', async () => {
  // With the flag ON, platformOr400 lets 'tiktok' through. Without Composio
  // configured (COMPOSIO_ENABLED unset), the handler returns 409 composio_disabled
  // — but the point is it must NOT return 400 unsupported_platform.
  await withEnv({ ARIES_TIKTOK_ENABLED: '1' }, async () => {
    const req = new Request(
      'https://aries.example.com/api/integrations/composio/tiktok/connect',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
    );
    const response = await handleComposioConnect(req, 'tiktok', tenantLoader);
    const body = (await response.json()) as { reason?: string };
    assert.notEqual(
      response.status,
      400,
      'status must not be 400 when tiktok is enabled',
    );
    assert.notEqual(
      body.reason,
      'unsupported_platform',
      'reason must not be unsupported_platform when tiktok is enabled',
    );
  });
});

test('handleComposioList flag-ON: response connections include tiktok (7 slots, x still dormant)', async () => {
  // Only ARIES_TIKTOK_ENABLED is set; X stays off → 7 slots total.
  await withEnv({ ARIES_TIKTOK_ENABLED: '1' }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string }>;
    };
    const platforms = body.connections.map((c) => c.platform);
    assert.ok(
      platforms.includes('tiktok'),
      "tiktok must appear in connection list when ARIES_TIKTOK_ENABLED=1",
    );
    assert.equal(platforms.length, 7, '7 connection slots when flag is on (x still dormant)');
  });
});

// ── 3. Config wiring ─────────────────────────────────────────────────────────

test('TOOLKIT_SLUG.tiktok === tiktok (Composio toolkit name for TikTok)', () => {
  assert.equal(TOOLKIT_SLUG.tiktok, 'tiktok');
});

test('composioAuthConfigId tiktok: reads COMPOSIO_TIKTOK_AUTH_CONFIG_ID when set', () => {
  assert.equal(
    composioAuthConfigId('tiktok', mkEnv({ COMPOSIO_TIKTOK_AUTH_CONFIG_ID: 'ac_tt' })),
    'ac_tt',
  );
});

test('composioAuthConfigId tiktok: returns null when COMPOSIO_TIKTOK_AUTH_CONFIG_ID is unset', () => {
  assert.equal(composioAuthConfigId('tiktok', mkEnv({})), null);
});

test('composioAuthConfigId tiktok: returns null when only COMPOSIO_DEFAULT_AUTH_CONFIG_ID is set (no default fallback, #690)', () => {
  // tiktok must NOT inherit COMPOSIO_DEFAULT_AUTH_CONFIG_ID — that is typically
  // a Meta-family config and would route a TikTok connection through the wrong
  // toolkit if the platform is ever accidentally unblocked (#690 defense-in-depth).
  assert.equal(
    composioAuthConfigId('tiktok', mkEnv({ COMPOSIO_DEFAULT_AUTH_CONFIG_ID: 'ac_default' })),
    null,
  );
});

// ── 4. metaPlatform #690 defense-in-depth ────────────────────────────────────

test('metaPlatform tiktok: throws (gated out — no Composio publish path, #690)', () => {
  // A dormant tiktok post must never silently fall through to facebook in the
  // publish dispatch seam. metaPlatform('tiktok') is the explicit throw guard.
  assert.throws(
    () => metaPlatform('tiktok'),
    /tiktok is not a supported publish platform/,
  );
});

test('metaPlatform sanity: facebook and instagram still map correctly', () => {
  assert.equal(metaPlatform('facebook'), 'facebook');
  assert.equal(metaPlatform('instagram'), 'instagram');
});

// ── 5. Regression guard: the 6 still-connectable platforms remain byte-identical ──

test('connectablePlatforms flag-OFF: all 6 still-connectable platforms present (no x, no tiktok)', () => {
  const off = connectablePlatforms(mkEnv({}));
  const original6 = [
    'facebook',
    'instagram',
    'meta_ads',
    'youtube',
    'linkedin',
    'reddit',
  ] as const;
  for (const p of original6) {
    assert.ok(off.includes(p), `${p} must be present with flag OFF`);
  }
});

test('connectablePlatforms flag-ON: all 7 platforms present (6 base + tiktok, x still dormant)', () => {
  const on = connectablePlatforms(mkEnv({ ARIES_TIKTOK_ENABLED: '1' }));
  const all7 = [
    'facebook',
    'instagram',
    'meta_ads',
    'tiktok',
    'youtube',
    'linkedin',
    'reddit',
  ] as const;
  for (const p of all7) {
    assert.ok(on.includes(p), `${p} must be present with flag ON`);
  }
});

test('isIntegrationPlatform tiktok: always true regardless of flag (pure type guard)', () => {
  // The type guard checks INTEGRATION_PLATFORMS array membership, not the env flag.
  // The dormancy chokepoint is connectablePlatforms(), not this predicate.
  assert.equal(isIntegrationPlatform('tiktok'), true);
});
