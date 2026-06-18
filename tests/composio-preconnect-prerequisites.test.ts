/**
 * Regression coverage for #691: per-platform connection prerequisite hints
 * surfaced PRE-connect on the connections screen.
 *
 * Before this fix:
 *  - `platformPrerequisites` did not exist (was not exported from
 *    capability-preflight.ts), so callers had no way to retrieve the advisory
 *    copy before a connection was established.
 *  - `handleComposioList` did not attach a `prerequisites` field to connection
 *    objects, so the frontend had nothing to render as a pre-connect hint.
 *
 * Failure modes locked:
 *  a. platformPrerequisites('instagram') returns a non-empty array containing
 *     the Business/Creator account advisory string.
 *  b. platformPrerequisites('facebook') returns a non-empty array containing
 *     the Facebook Page advisory string.
 *  c. platformPrerequisites for a platform with no PLATFORM_WARNINGS entry
 *     returns an empty array (not undefined, not null, not an error).
 *  d. handleComposioList response includes a `prerequisites` field on every
 *     connection object.
 *  e. instagram/facebook connection objects carry a non-empty `prerequisites`
 *     array (the pre-connect hints are actually wired into the payload).
 *  f. Regression guard: x platform (no PLATFORM_WARNINGS entry) carries an
 *     empty `prerequisites` array in the payload (never undefined).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { platformPrerequisites } from '@/backend/integrations/composio/capability-preflight';
import { handleComposioList } from '@/app/api/integrations/composio/handlers';
import type { TenantRole } from '@/lib/tenant-context';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal tenant loader — same pattern as composio-x-connect.test.ts.
 * Composio is intentionally not configured so the handler falls back to
 * not-connected placeholders (provider === null path), which is the
 * pre-connect state we are testing.
 */
const tenantLoader = async () => ({
  userId: 'user_1',
  tenantId: '1',
  tenantSlug: 'test-tenant',
  role: 'tenant_admin' as TenantRole,
});

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

// ── a. platformPrerequisites('instagram') ────────────────────────────────────

test('#691 platformPrerequisites instagram: non-empty, includes Business/Creator account advisory', () => {
  const prereqs = platformPrerequisites('instagram');
  assert.ok(Array.isArray(prereqs), 'must return an array');
  assert.ok(prereqs.length > 0, 'instagram must have at least one prerequisite string');
  const joined = prereqs.join(' ');
  assert.ok(
    joined.includes('Business') || joined.includes('Creator'),
    `instagram prerequisites must mention Business or Creator account; got: ${joined}`,
  );
  assert.ok(
    joined.includes('Facebook Page') || joined.includes('linked to a Facebook'),
    `instagram prerequisites must mention Facebook Page linkage; got: ${joined}`,
  );
});

// ── b. platformPrerequisites('facebook') ─────────────────────────────────────

test('#691 platformPrerequisites facebook: non-empty, includes Facebook Page advisory', () => {
  const prereqs = platformPrerequisites('facebook');
  assert.ok(Array.isArray(prereqs), 'must return an array');
  assert.ok(prereqs.length > 0, 'facebook must have at least one prerequisite string');
  const joined = prereqs.join(' ');
  assert.ok(
    joined.toLowerCase().includes('page'),
    `facebook prerequisites must mention Page; got: ${joined}`,
  );
});

// ── c. platformPrerequisites for a platform with no entry returns [] ──────────

test('#691 platformPrerequisites x: returns empty array (no PLATFORM_WARNINGS entry)', () => {
  // 'x' is not in PLATFORM_WARNINGS — the selector must return [] not undefined.
  const prereqs = platformPrerequisites('x');
  assert.ok(Array.isArray(prereqs), 'must return an array even for platforms without warnings');
  assert.equal(prereqs.length, 0, 'x must have no prerequisites (no PLATFORM_WARNINGS entry)');
});

// ── d+e. handleComposioList payload includes prerequisites on each connection ─

test('#691 handleComposioList: every connection object has a prerequisites field', async () => {
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string; prerequisites: unknown }>;
    };
    assert.ok(Array.isArray(body.connections), 'connections must be an array');
    assert.ok(body.connections.length > 0, 'must have at least one connection slot');
    for (const conn of body.connections) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(conn, 'prerequisites'),
        `connection for ${conn.platform} must have a prerequisites field`,
      );
      assert.ok(
        Array.isArray(conn.prerequisites),
        `prerequisites for ${conn.platform} must be an array; got ${typeof conn.prerequisites}`,
      );
    }
  });
});

test('#691 handleComposioList: instagram connection carries non-empty prerequisites', async () => {
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string; prerequisites: string[] }>;
    };
    const igConn = body.connections.find((c) => c.platform === 'instagram');
    assert.ok(igConn, 'instagram connection slot must be present in the list');
    assert.ok(
      igConn.prerequisites.length > 0,
      'instagram connection must carry at least one prerequisite string in the payload',
    );
    const joined = igConn.prerequisites.join(' ');
    assert.ok(
      joined.includes('Business') || joined.includes('Creator'),
      `instagram prerequisites in payload must mention Business or Creator; got: ${joined}`,
    );
  });
});

test('#691 handleComposioList: facebook connection carries non-empty prerequisites', async () => {
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string; prerequisites: string[] }>;
    };
    const fbConn = body.connections.find((c) => c.platform === 'facebook');
    assert.ok(fbConn, 'facebook connection slot must be present in the list');
    assert.ok(
      fbConn.prerequisites.length > 0,
      'facebook connection must carry at least one prerequisite string in the payload',
    );
    const joined = fbConn.prerequisites.join(' ');
    assert.ok(
      joined.toLowerCase().includes('page'),
      `facebook prerequisites in payload must mention Page; got: ${joined}`,
    );
  });
});

// ── f. Regression guard: x (no warnings) carries empty prerequisites array ──

test('#691 handleComposioList flag-ON: x connection carries empty prerequisites array (not undefined)', async () => {
  await withEnv({ ARIES_X_ENABLED: '1' }, async () => {
    const response = await handleComposioList(tenantLoader);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string; prerequisites: string[] }>;
    };
    const xConn = body.connections.find((c) => c.platform === 'x');
    assert.ok(xConn, 'x connection slot must be present when flag is ON');
    assert.ok(
      Array.isArray(xConn.prerequisites),
      `x prerequisites must be an array; got ${typeof xConn.prerequisites}`,
    );
    assert.equal(
      xConn.prerequisites.length,
      0,
      'x must carry an empty prerequisites array (no PLATFORM_WARNINGS entry for x)',
    );
  });
});
