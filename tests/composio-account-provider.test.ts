import { test } from "node:test";
import assert from "node:assert/strict";

import { ComposioAccountProvider } from "@/backend/integrations/composio/composio-account-provider";
import { ComposioError, ComposioConfigError } from "@/backend/integrations/composio/errors";
import type { GatewayConnection, ComposioGateway } from "@/backend/integrations/composio/composio-client";
import { fakeConfig, fakeGateway, fakeDb } from "./composio/helpers";

const tenantId = "42";
const userId = "aries-tenant-42";

function conn(id: string, toolkitSlug: string, status = "ACTIVE"): GatewayConnection {
  return {
    id,
    status,
    statusReason: null,
    authConfigId: "shared_default",
    toolkitSlug,
    externalAccountId: `ext_${id}`,
    externalAccountName: `${toolkitSlug} acct`,
    raw: {},
  };
}

test("createConnectLink with no configured auth config auto-provisions a managed one", async () => {
  // No env auth config -> the provider asks the gateway to find-or-create a
  // Composio-managed auth config for the toolkit, so connecting needs zero
  // dashboard setup.
  const provider = new ComposioAccountProvider(
    fakeGateway(),
    fakeConfig({ authConfigId: null }),
    fakeDb(),
  );
  const result = await provider.createConnectLink(userId, "facebook", "full", { tenantId });
  assert.equal(result.connectUrl, "https://composio.dev/connect/abc");
});

test("createConnectLink returns the redirect URL and persists a pending row", async () => {
  // Default fakeDb returns a row for the upsert's RETURNING clause (Postgres
  // always returns the upserted row), matching real behavior.
  const db = fakeDb();
  const provider = new ComposioAccountProvider(fakeGateway(), fakeConfig(), db);
  const result = await provider.createConnectLink(userId, "facebook", "full", { tenantId });
  assert.equal(result.connectUrl, "https://composio.dev/connect/abc");
  assert.ok(db.queries.some((q) => /insert into connected_accounts/i.test(q.text)));
});

test("refreshConnectionStatus picks the toolkit-matching connection under a shared default auth config", async () => {
  // Both an instagram and a facebook connection come back (shared default
  // auth config). Refreshing facebook must NOT store the instagram account id.
  const gateway = fakeGateway({ connections: [conn("ca_ig", "instagram"), conn("ca_fb", "facebook")] });
  const db = fakeDb();
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  await provider.refreshConnectionStatus(userId, "facebook", { tenantId });
  const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
  assert.ok(upsert, "expected an upsert");
  // connected_account_id is param index 5 (1-based $5) -> array index 4.
  assert.equal(upsert!.params[4], "ca_fb", "must persist the facebook connected-account id, not instagram");
});

// ── Fix A: #699 — platform-scoped authConfig admits non-exact-slug ACTIVE conn ──

test("#699 Fix A: platform-scoped authConfig with non-exact toolkitSlug ACTIVE connection reconciles to connected", async () => {
  // Root of #699: Instagram Composio connections report toolkitSlug
  // 'instagram_business' rather than the hard-coded 'instagram'. With a
  // platform-specific (non-default) authConfigId, the filter previously
  // returned candidates=[] on any slug mismatch and left the row stranded as
  // pending. The fix: when platformScoped=true (authConfigId !== null AND !=
  // defaultAuthConfigId), fall through to admitting ALL returned connections
  // (they are already this-platform-only). Pre-fix: no upsert fired. Post-fix:
  // the ACTIVE connection is persisted as 'connected'.
  const gateway = fakeGateway({
    connections: [conn("ca_ig_biz", "instagram_business", "ACTIVE")],
  });
  const db = fakeDb();
  // authConfigId is platform-specific; defaultAuthConfigId stays null (the default
  // when unset). platformScoped = 'ac_ig_specific' !== null && !== null = true.
  const provider = new ComposioAccountProvider(
    gateway,
    fakeConfig({ authConfigId: "ac_ig_specific" }),
    db,
  );
  await provider.refreshConnectionStatus(userId, "instagram", { tenantId });
  const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
  assert.ok(upsert, "expected an upsert INSERT for the ACTIVE connection");
  // $5 = connectedAccountId (array index 4, 0-based)
  assert.equal(upsert!.params[4], "ca_ig_biz",
    "must persist the instagram_business connected-account id, not leave it as pending");
  // $9 = status (array index 8)
  assert.equal(upsert!.params[8], "connected",
    "status must be persisted as 'connected' for an ACTIVE Composio connection");
});

// ── Fix A safety: shared-default must still not cross-contaminate platforms ──

test("#699 Fix A regression: shared-default authConfig does not cross-contaminate platforms on slug mismatch", async () => {
  // When authConfigId === defaultAuthConfigId (the shared default), listConnections
  // returns connections for ALL platforms. The slug guard must still prevent a
  // non-matching platform's connected-account id from being persisted onto a
  // different platform's row. With shared default + zero exact slug matches,
  // candidates=[] → no upsert.
  const gateway = fakeGateway({
    connections: [
      conn("ca_fb", "facebook"),
      conn("ca_ig_biz", "instagram_business"),
    ],
  });
  const db = fakeDb();
  // authConfigId === defaultAuthConfigId: the shared-default path.
  const provider = new ComposioAccountProvider(
    gateway,
    fakeConfig({ authConfigId: "ac_default", defaultAuthConfigId: "ac_default" }),
    db,
  );
  // Refresh for 'instagram': slugMatched=[] (neither 'facebook' nor 'instagram_business'
  // equals 'instagram'); platformScoped=false; candidates=[] (both have slugs).
  await provider.refreshConnectionStatus(userId, "instagram", { tenantId });
  const upserts = db.queries.filter((q) => /insert into connected_accounts/i.test(q.text));
  assert.equal(
    upserts.length,
    0,
    "shared-default path must NOT upsert any row when no connection's slug exactly matches the platform",
  );
});

// ── Fix B: gateway.listConnections rejection rethrows frontend-safe ComposioError ──

test("#699 Fix B: refreshConnectionStatus rethrows a frontend-safe ComposioError when listConnections rejects", async () => {
  // Pre-fix: a gateway network error caused refreshConnectionStatus to silently
  // return the stored 'pending' row, masking the failure and stranding the
  // connection forever. The fix: rethrow as ComposioError with
  // reason='composio_reconcile_failed' and a generic message (never the raw SDK
  // text). The caller (handleComposioList) catches this per-platform and records
  // a frontend-safe advisory without failing the whole list request.
  const rawSdkError = "SENTINEL_RAW_SDK_TEXT: internal Composio SDK failure";
  const throwingGateway: ComposioGateway = {
    ...fakeGateway(),
    async listConnections(): Promise<GatewayConnection[]> {
      throw new Error(rawSdkError);
    },
  };
  const provider = new ComposioAccountProvider(throwingGateway, fakeConfig(), fakeDb());

  await assert.rejects(
    () => provider.refreshConnectionStatus(userId, "instagram", { tenantId }),
    (err: unknown) => {
      assert.ok(
        err instanceof ComposioError,
        `expected ComposioError to be thrown, got ${String(err)}`,
      );
      assert.equal(
        (err as ComposioError).code,
        "composio_reconcile_failed",
        `expected reason composio_reconcile_failed; got ${(err as ComposioError).code}`,
      );
      assert.ok(
        !err.message.includes(rawSdkError),
        `message must NOT include raw SDK error text; got: ${err.message}`,
      );
      return true;
    },
  );
});
