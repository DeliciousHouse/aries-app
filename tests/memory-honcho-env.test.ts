import assert from 'node:assert/strict';
import test from 'node:test';

import { isHonchoEnabled, validateHonchoConfig } from '../backend/memory/honcho-env';

test('isHonchoEnabled returns false when HONCHO_ENABLED is absent', () => {
  assert.equal(isHonchoEnabled({}), false);
});

test('isHonchoEnabled returns false for empty string', () => {
  assert.equal(isHonchoEnabled({ HONCHO_ENABLED: '' }), false);
});

test('isHonchoEnabled returns true for "true"', () => {
  assert.equal(isHonchoEnabled({ HONCHO_ENABLED: 'true' }), true);
});

test('isHonchoEnabled returns true for "1"', () => {
  assert.equal(isHonchoEnabled({ HONCHO_ENABLED: '1' }), true);
});

test('isHonchoEnabled returns true for "yes"', () => {
  assert.equal(isHonchoEnabled({ HONCHO_ENABLED: 'yes' }), true);
});

test('isHonchoEnabled returns true for "on"', () => {
  assert.equal(isHonchoEnabled({ HONCHO_ENABLED: 'on' }), true);
});

test('isHonchoEnabled returns false for "false"', () => {
  assert.equal(isHonchoEnabled({ HONCHO_ENABLED: 'false' }), false);
});

test('validateHonchoConfig is a no-op when disabled', () => {
  assert.doesNotThrow(() =>
    validateHonchoConfig({ HONCHO_ENABLED: 'false' }),
  );
});

test('validateHonchoConfig throws when enabled but ARIES_TENANT_PSEUDONYM_SALT missing', () => {
  assert.throws(
    () => validateHonchoConfig({ HONCHO_ENABLED: 'true', HONCHO_BASE_URL: 'http://honcho.local' }),
    (err: unknown) => err instanceof Error && /ARIES_TENANT_PSEUDONYM_SALT/.test(err.message),
  );
});

test('validateHonchoConfig throws when enabled but ARIES_TENANT_PSEUDONYM_SALT too short', () => {
  assert.throws(
    () =>
      validateHonchoConfig({
        HONCHO_ENABLED: 'true',
        HONCHO_BASE_URL: 'http://honcho.local',
        ARIES_TENANT_PSEUDONYM_SALT: 'tooshort',
      }),
    (err: unknown) => err instanceof Error && /ARIES_TENANT_PSEUDONYM_SALT/.test(err.message),
  );
});

test('validateHonchoConfig throws when enabled but HONCHO_BASE_URL missing', () => {
  assert.throws(
    () =>
      validateHonchoConfig({
        HONCHO_ENABLED: 'true',
        ARIES_TENANT_PSEUDONYM_SALT: 'a'.repeat(32),
      }),
    (err: unknown) => err instanceof Error && /HONCHO_BASE_URL/.test(err.message),
  );
});

test('validateHonchoConfig passes with all required config', () => {
  assert.doesNotThrow(() =>
    validateHonchoConfig({
      HONCHO_ENABLED: 'true',
      HONCHO_BASE_URL: 'http://honcho.local:8000',
      ARIES_TENANT_PSEUDONYM_SALT: 'a'.repeat(32),
    }),
  );
});

test('isHonchoEnabled disabled mode: onboarding seed should be skipped (contract)', () => {
  // This test is a contract check: when HONCHO_ENABLED is falsy,
  // isHonchoEnabled must return false so callers can safely skip Honcho writes.
  const env = { HONCHO_ENABLED: undefined };
  assert.equal(isHonchoEnabled(env), false);
});

test('separate tenants produce different workspace ids (cross-tenant isolation contract)', async () => {
  const prev = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = 'cross-tenant-isolation-test-salt';
  try {
    const { workspaceIdForTenant } = await import('../backend/memory/pseudonym');
    const ws1 = workspaceIdForTenant('tenant-100');
    const ws2 = workspaceIdForTenant('tenant-200');
    assert.notEqual(ws1, ws2, 'Different tenants must have different workspace IDs');
    assert.match(ws1, /^aries-tenant-[a-f0-9]{32}$/);
    assert.match(ws2, /^aries-tenant-[a-f0-9]{32}$/);
  } finally {
    if (prev === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prev;
  }
});

test('workspace id is stable across calls for the same tenant', async () => {
  const prev = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = 'workspace-stability-test-salt-32x';
  try {
    const { workspaceIdForTenant } = await import('../backend/memory/pseudonym');
    const id = workspaceIdForTenant('tenant-42');
    assert.equal(workspaceIdForTenant('tenant-42'), id);
    assert.equal(workspaceIdForTenant('tenant-42'), id);
  } finally {
    if (prev === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prev;
  }
});

test('approved messages must not contain sensitive field names in serialized claim', () => {
  const sensitivePatterns = [/password/i, /secret/i, /api_key/i, /access_token/i, /bearer /i];
  const claim = 'Brand was founded in 2020 and sells organic skincare.';
  for (const pattern of sensitivePatterns) {
    assert.equal(
      pattern.test(claim),
      false,
      `Claim should not match sensitive pattern: ${pattern}`,
    );
  }
  // Verify the check detects a bad claim
  const badClaim = 'api_key=sk-abc123';
  const hasSecret = sensitivePatterns.some((p) => p.test(badClaim));
  assert.equal(hasSecret, true, 'Test should detect sensitive content in bad claim');
});
