import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARIES_TENANT_WORKSPACE_PREFIX,
  isAriesTenantWorkspace,
  pseudonymForTenant,
  pseudonymForUser,
  workspaceIdForTenant,
} from '../backend/memory/pseudonym';
import { MemoryError } from '../backend/memory/errors';

function withSalt<T>(salt: string | undefined, run: () => T): T {
  const prev = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  if (salt === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
  else process.env.ARIES_TENANT_PSEUDONYM_SALT = salt;
  try {
    return run();
  } finally {
    if (prev === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prev;
  }
}

test('pseudonymForTenant is deterministic for a given salt', () => {
  withSalt('test-salt-1234567890abcdef', () => {
    const a1 = pseudonymForTenant('tenant-1');
    const a2 = pseudonymForTenant('tenant-1');
    assert.equal(a1, a2);
    assert.equal(a1.length, 32);
  });
});

test('pseudonymForTenant differs across tenants', () => {
  withSalt('test-salt-1234567890abcdef', () => {
    assert.notEqual(pseudonymForTenant('tenant-1'), pseudonymForTenant('tenant-2'));
  });
});

test('pseudonymForTenant changes when the salt changes', () => {
  const fixed = withSalt('salt-aaaaaaaaaaaaaaaa', () => pseudonymForTenant('tenant-1'));
  const rotated = withSalt('salt-bbbbbbbbbbbbbbbb', () => pseudonymForTenant('tenant-1'));
  assert.notEqual(fixed, rotated);
});

test('pseudonymForUser uses a separate domain from tenant pseudonyms', () => {
  withSalt('test-salt-1234567890abcdef', () => {
    assert.notEqual(pseudonymForTenant('42'), pseudonymForUser('42'));
  });
});

test('workspaceIdForTenant lives under the aries-tenant-* namespace', () => {
  withSalt('test-salt-1234567890abcdef', () => {
    const wsid = workspaceIdForTenant('tenant-1');
    assert.ok(wsid.startsWith(ARIES_TENANT_WORKSPACE_PREFIX));
    assert.ok(isAriesTenantWorkspace(wsid));
    assert.equal(wsid.length, ARIES_TENANT_WORKSPACE_PREFIX.length + 32);
  });
});

test('missing or weak salt fails closed', () => {
  withSalt(undefined, () => {
    assert.throws(() => pseudonymForTenant('tenant-1'), (err: unknown) => {
      return err instanceof MemoryError && err.code === 'pseudonym_salt_missing';
    });
  });
  withSalt('short', () => {
    assert.throws(() => pseudonymForTenant('tenant-1'), (err: unknown) => {
      return err instanceof MemoryError && err.code === 'pseudonym_salt_missing';
    });
  });
});

test('empty tenantId is rejected', () => {
  withSalt('test-salt-1234567890abcdef', () => {
    assert.throws(() => pseudonymForTenant(''), (err: unknown) => {
      return err instanceof MemoryError && err.code === 'tenant_context_required';
    });
  });
});

test('isAriesTenantWorkspace rejects foreign workspaces', () => {
  assert.equal(isAriesTenantWorkspace('hermes'), false);
  assert.equal(isAriesTenantWorkspace('aries-tenant-abc'), true);
  assert.equal(isAriesTenantWorkspace(''), false);
});
