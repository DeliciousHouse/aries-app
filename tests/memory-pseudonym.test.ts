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

test('pseudonym domain separation: a synthetic tenant-id-as-user can never collide with a real user peer', () => {
  // Multi-workspace plan, Taste/Honcho verification hardening: two synthetic
  // contexts used to pass userId: tenantId. pseudonymForUser("15") cannot
  // distinguish tenant 15 from user 15 — under multi-workspace a
  // (user N ∈ tenant N) pair is possible, so synthetic actors must use the
  // 'system' sentinel instead. Pins: (a) the user domain is HMAC'd with the
  // 'aries-user:' prefix, so no user pseudonym ever equals a tenant
  // pseudonym for any id; (b) the 'system' sentinel maps to its own peer,
  // distinct from every numeric user id it could otherwise shadow.
  withSalt('test-salt-1234567890abcdef', () => {
    for (const id of ['15', '42', 'system']) {
      assert.notEqual(pseudonymForUser(id), pseudonymForTenant(id), `domain collision for id=${id}`);
    }
    assert.notEqual(pseudonymForUser('system'), pseudonymForUser('15'));
    assert.notEqual(pseudonymForUser('system'), pseudonymForUser('42'));
    // Determinism: the sentinel is a stable synthetic peer, not a random one.
    assert.equal(pseudonymForUser('system'), pseudonymForUser('system'));
  });
});

test('synthetic contexts pass the system sentinel, never tenantId-as-userId (structural pin)', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  for (const rel of ['backend/memory/write-events.ts', 'scripts/automations/honcho-performance-worker.ts']) {
    const src = readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(
      !/userId:\s*tenantId(Str)?\b/.test(src),
      `${rel} must not pass the tenant id as a userId (use the 'system' sentinel)`,
    );
    assert.ok(
      /userId:\s*'system'/.test(src),
      `${rel} synthetic context must carry the 'system' sentinel`,
    );
  }
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
