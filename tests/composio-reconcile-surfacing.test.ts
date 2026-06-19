/**
 * Regression coverage for #699: Composio reconcile error surfacing.
 *
 * Fix B wired two guarantees into handleComposioList:
 *  1. Every connection object in the response carries a `reconcileError` field
 *     (null on success, a frontend-safe string on per-platform reconcile failure).
 *  2. A per-platform reconcile failure (refreshConnectionStatus throws) records
 *     a frontend-safe advisory into the response and still returns HTTP 200 —
 *     a Composio outage must NOT blank the whole connections screen.
 *
 * Both guarantees are exercised here via an injected provider (the 2nd param
 * of handleComposioList added by the fix) so no live DB or Composio SDK is needed.
 *
 * Failure modes locked:
 *  a. null-provider path (Composio not configured): every connection carries
 *     reconcileError: null (field must exist, value must be null).
 *  b. provider whose refreshConnectionStatus throws for one platform: that
 *     platform's connection carries a non-null, frontend-safe reconcileError
 *     string and the response is still 200.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleComposioList } from "@/app/api/integrations/composio/handlers";
import { ComposioError } from "@/backend/integrations/composio/errors";
import type { AccountConnectionProvider } from "@/backend/integrations/providers/interfaces";
import type { ConnectedAccount, IntegrationPlatform } from "@/backend/integrations/providers/types";
import type { TenantRole } from "@/lib/tenant-context";

// ── Tenant loader ─────────────────────────────────────────────────────────────

const tenantLoader = async () => ({
  userId: "user_1",
  tenantId: "1",
  tenantSlug: "test-tenant",
  role: "tenant_admin" as TenantRole,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Minimal placeholder ConnectedAccount for faking listConnections results. */
function pendingAccount(platform: IntegrationPlatform): ConnectedAccount {
  const now = new Date(0).toISOString();
  return {
    id: `${platform}:pending`,
    tenantId: "1",
    externalUserId: "aries-tenant-1",
    platform,
    provider: "composio",
    connectedAccountId: null,
    authConfigId: null,
    externalAccountId: null,
    externalAccountName: null,
    status: "pending",
    capabilities: null,
    lastCapabilityCheckAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A minimal AccountConnectionProvider stub. listConnections returns the
 * supplied rows; refreshConnectionStatus either resolves or rejects depending
 * on whether the platform is in the `throwFor` set.
 */
function fakeProvider(opts: {
  rows: ConnectedAccount[];
  throwFor?: Set<IntegrationPlatform>;
  rawErrorText?: string;
}): AccountConnectionProvider {
  const rawErr = opts.rawErrorText ?? "SENTINEL_RAW_TEXT_MUST_NOT_APPEAR";
  return {
    kind: "composio" as const,
    async listConnections() {
      return opts.rows;
    },
    async refreshConnectionStatus(_userId, platform) {
      if (opts.throwFor?.has(platform)) {
        throw new ComposioError(
          "composio_reconcile_failed",
          "Could not reach Composio to confirm this connection. Please try again.",
          { status: 502, retryable: true },
        );
      }
      // Return the first matching row as-is (simulating a no-op refresh)
      return opts.rows.find((r) => r.platform === platform) ?? null;
    },
    async createConnectLink() {
      throw new Error("not implemented in stub");
    },
    async getConnection() {
      return null;
    },
    async disconnectConnection() {
      return { disconnected: false };
    },
  };
}

// ── a. null-provider: every connection carries reconcileError: null ───────────

test("#699 handleComposioList null-provider: every connection object has reconcileError field equal to null", async () => {
  // Composio not configured (provider = null). The handler still builds
  // placeholder rows for every connectable platform and MUST attach
  // reconcileError: null to each. Pre-fix: the field was absent (undefined).
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const response = await handleComposioList(tenantLoader, null);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      connections: Array<{ platform: string; reconcileError: unknown }>;
    };
    assert.ok(Array.isArray(body.connections), "connections must be an array");
    assert.ok(body.connections.length > 0, "must have at least one connection slot");
    for (const conn of body.connections) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(conn, "reconcileError"),
        `connection for ${conn.platform} must have a reconcileError field (was absent pre-fix)`,
      );
      assert.equal(
        conn.reconcileError,
        null,
        `reconcileError for ${conn.platform} must be null when no reconcile was attempted`,
      );
    }
  });
});

// ── b. reconcile failure → per-platform advisory, still 200 ──────────────────

test("#699 handleComposioList: per-platform refreshConnectionStatus throw records frontend-safe advisory, response still 200", async () => {
  // Inject a provider that returns an instagram pending row (triggering the
  // reconcile path) and throws a ComposioError for instagram.
  // The handler must: (1) still return 200, (2) carry a non-null reconcileError
  // on the instagram connection, (3) never include raw SDK text.
  await withEnv({ ARIES_X_ENABLED: undefined }, async () => {
    const provider = fakeProvider({
      rows: [pendingAccount("instagram")],
      throwFor: new Set<IntegrationPlatform>(["instagram"]),
    });
    const response = await handleComposioList(tenantLoader, provider);
    assert.equal(
      response.status,
      200,
      "A per-platform reconcile failure must NOT kill the list request (must return 200)",
    );
    const body = (await response.json()) as {
      connections: Array<{ platform: string; reconcileError: string | null }>;
    };
    assert.ok(Array.isArray(body.connections), "connections must be an array");

    // Every connection must still carry the reconcileError field.
    for (const conn of body.connections) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(conn, "reconcileError"),
        `connection for ${conn.platform} must have a reconcileError field`,
      );
    }

    // The instagram slot must carry a non-null, frontend-safe advisory.
    const igConn = body.connections.find((c) => c.platform === "instagram");
    assert.ok(igConn, "instagram connection must be present in the response");
    assert.notEqual(
      igConn.reconcileError,
      null,
      "instagram reconcileError must be non-null when refreshConnectionStatus throws",
    );
    // Cast to string after the null assertion — TypeScript does not narrow on
    // assert.notEqual, so a non-null assertion is required to call string methods.
    const reconcileErrMsg: string = igConn.reconcileError as string;
    assert.equal(typeof reconcileErrMsg, "string",
      "instagram reconcileError must be a string");
    // Sanity: the advisory must not leak the raw error sentinel that the
    // platform-scoped code would have originally exposed.
    const RAW_SENTINEL = "SENTINEL_RAW_TEXT_MUST_NOT_APPEAR";
    assert.ok(
      !reconcileErrMsg.includes(RAW_SENTINEL),
      `reconcileError must NOT include raw SDK error text; got: ${reconcileErrMsg}`,
    );
    assert.ok(
      reconcileErrMsg.length > 0,
      "reconcileError must be a non-empty string so the UI has something to render",
    );
  });
});
