# Per-tenant Slack approval notifications (Option A native OAuth, then Option B Composio)

Branch: claude/stupefied-hawking-03a9a0
Date: 2026-06-09
Status: DRAFT — for /plan-eng-review

## Problem / why

Slack PR2 ([#579](https://github.com/DeliciousHouse/aries-app/pull/579), v0.1.15.21, flag-OFF) ships outbound "needs approval" notifications, but uses a **single global** bot token + channel from the prod `.env` (`SLACK_BOT_TOKEN` / `SLACK_NOTIFY_CHANNEL`). That is correct for today's single-tenant prod (tenant 15) but does not scale: with >1 tenant, every tenant's approval prompts land in one shared channel — a cross-tenant disclosure gap the PR2 security review flagged. To make Slack notifications a real multi-customer feature, each customer must connect their **own** Slack workspace and channel, and the notifier must resolve the right credentials **per tenant** at send time — with no central admin managing per-customer tokens.

This plan delivers that in two phases:
- **Option A (build first): Aries-native Slack OAuth** — mirror the existing per-tenant Meta OAuth pattern. We own one Slack app; each customer installs it into their workspace and picks a channel; Aries stores the bot token encrypted per tenant and resolves it per notification.
- **Option B (after A): Composio-managed Slack** — route Slack through the existing default-OFF Composio managed-connections layer so Aries stores only a pointer, not tokens. Gated on verifying Composio ships a Slack send-message toolkit.

## Verified current state (from two read-only investigation workflows)

- **Per-tenant OAuth already exists** (the template): `oauth_connections` (`UNIQUE(tenant_id, provider)`, `status`, `external_account_id`) + `oauth_tokens` (`access_token_enc` AES-256-GCM via `OAUTH_TOKEN_ENCRYPTION_KEY`, `refresh_token_enc`, `expires_at`, `revoked_at`) + `oauth_pending_states` (CSRF state, 10-min TTL). Connect flow: `backend/integrations/meta/connect.ts` `oauthConnect()` → callback `oauthCallback()` exchanges the code → `dbInsertOAuthToken()`. Read path: `getDecryptedAccessTokenContextForTenantProvider(tenantId, provider)` (`oauth-credentials.ts`), crypto in `oauth-crypto.ts`.
- **Settings UI already renders connect/disconnect cards**: `frontend/aries-v1/channel-integrations-screen.tsx` at `/dashboard/settings/channel-integrations`, driven by `backend/integrations/provider-registry.ts` (FB/IG/LinkedIn/X/YouTube/TikTok/Reddit/OpenAI). **Slack is absent from the registry** — a natural home for an "Connect Slack" card.
- **The notify call site already has the tenant**: `notifyApprovalRequired({ tenantId: doc.tenant_id, ... })` at `backend/marketing/hermes-callbacks.ts:2040`. `notifyApprovalRequired` (`backend/integrations/slack/notifications.ts`) already accepts an optional `tenantId` + injectable `clientDeps`/`pool`. It currently reads `env.SLACK_NOTIFY_CHANNEL` and `process.env.SLACK_BOT_TOKEN` (via `client.ts`).
- **Dedup table already carries `tenant_id`**: `slack_notifications(dedup_key PK, kind, tenant_id, marketing_job_id, sent_at)`. Dedup key is `approval:<jobId>:<stage>`; PK is `dedup_key` only.
- **Composio** is an optional, default-OFF managed-connections layer (`COMPOSIO_ENABLED=false`), stores only `connected_account_id` pointers in `connected_accounts` (keyed `(tenant_id, platform)`), currently scoped to **publishing** for facebook/instagram/meta_ads/tiktok/youtube/linkedin/reddit. **Slack is NOT in the `IntegrationPlatform` union** and it is **unverified** whether the Composio SDK ships a Slack toolkit.

---

## Option A — Aries-native Slack OAuth (Phase 1, build first)

### A1. Data model

Reuse `oauth_connections` + `oauth_tokens` exactly as Meta does, with `provider = 'slack'`:
- Add `'slack'` to the `oauth_connections.provider` allowed set (CHECK constraint / app-level enum) — grep for the provider literal union site-wide (the union-widening pitfall: also check `=== 'meta'`/`!== 'meta'` style literal-inequality sites).
- Store the bot token (`xoxb-`) in `oauth_tokens.access_token_enc` (encrypted). Slack bot tokens do not expire/rotate, so `expires_at`/`refresh_token_enc` stay null.
- **Per-tenant channel**: store the chosen channel id (`Cxxxx`) + a human label. Decision for review: a new `notify_channel_id`/`notify_channel_name` column on `oauth_connections`, vs a small dedicated `slack_notification_targets(tenant_id, channel_id, channel_name)` table. Recommendation: column on `oauth_connections` (one channel per tenant in v1; matches "one connection row per (tenant, provider)").
- `external_account_id` = Slack `team_id` (workspace id), plus store the workspace name for display.

Migration (additive + idempotent) + `scripts/init-db.js` lockstep, per repo convention.

### A2. OAuth connect flow (mirror Meta)

- New `backend/integrations/slack/oauth/connect.ts` + `callback.ts` (sibling of the existing `events/` dir): build the Slack OAuth v2 authorize URL (`https://slack.com/oauth/v2/authorize`) with the bot scopes, store a CSRF `state` in `oauth_pending_states`; the callback exchanges the code via `oauth.v2.access`, reads the `access_token` (`xoxb-`) + `team`, and persists via `dbInsertOAuthToken()`.
- New routes: `app/api/integrations/slack/oauth/connect/route.ts` (start) + `.../callback/route.ts` (return), tenant-resolved server-side.
- **Bot scopes**: `chat:write` (post), `channels:read`+`groups:read` (list channels for the picker). Add `chat:write.public` only if we want to post to public channels the bot is not in; default to inviting/selecting.
- **Slack app distribution decision (for review)**: one Slack app we own, distributed as an unlisted/"Add to Slack" OAuth app (no App Directory listing required for OAuth installs), OR a listed public app (needs Slack review). Recommendation: unlisted public-distribution OAuth app first; App Directory later if needed. Needs `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` env (the app's OAuth creds — NOT per-customer; those are the one app we own).

### A3. Channel selection UX

Slack OAuth grants a **workspace**, not a channel. After connect:
- Call `conversations.list` (with the bot token) to fetch channels the bot can post to; render a picker in the settings card. Persist the chosen `channel_id`.
- The bot must be a member of the chosen channel (or `chat:write.public` granted). Surface a "the bot isn't in #x — `/invite @Aries`" hint on `not_in_channel`.

### A4. Settings UI

- Register `slack` in `provider-registry.ts` (icon, family, labels).
- Add a Slack card to `channel-integrations-screen.tsx`: Connect (→ OAuth), show connected workspace + selected channel, change-channel, Disconnect (revoke + null the row). Reuse the existing connect/reconnect/disconnect pattern.
- **Screenshot-verify** the rendered card + a real connected state in Brendan's dashboard (only rendered output counts).

### A5. Tenant-scoped notifier (the surgical core)

- New `loadSlackConfigForTenant(tenantId): Promise<{ botToken, channel } | null>` — joins `oauth_connections`(provider='slack', status active) + decrypted `oauth_tokens` + the channel column.
- In `notifyApprovalRequired`: replace the global `env.SLACK_NOTIFY_CHANNEL` + `process.env.SLACK_BOT_TOKEN` reads with the resolver (injected as an optional dep for tests). **When null → skip cleanly** (`{ delivered:false, reason:'no_tenant_config' }`), no global fallback — enforce per-tenant isolation.
- Pass the resolved `botToken` to `postSlackMessage` via `clientDeps.botToken` and the resolved channel as `input.channel` (both injection points already exist).
- **Dedup**: change the unique constraint to `(tenant_id, dedup_key)` composite (the table already has `tenant_id`); update `alreadyDelivered`/`recordNotified` to key on both. Migration alters the PK/constraint.

### A6. Backward-compat for the existing single tenant

Decision for review: (a) keep the global `SLACK_*` env as a last-resort fallback **only when a tenant has no connection row** (helps self-hosters / the current single tenant without forcing an OAuth dance), or (b) drop the global path entirely and migrate tenant 15 to a connection row. Recommendation: (a) — resolver returns the per-tenant row if present, else the global env if set, else skip. Keeps PR2's working setup alive while making per-tenant the default. (This softens A5's "no fallback" for the single-tenant case — flag the tension for the reviewer.)

### A7. Tests + gates

- Unit: `loadSlackConfigForTenant` (present/absent/decrypt), resolver-null skip, composite dedup isolation (two tenants same jobId/stage don't collide), OAuth state CSRF, callback token persistence (encrypted, never logged).
- Reuse the PR2 dispatcher tests (now driven by the resolver).
- typecheck/lint/verify green; screenshot-verify the settings card + a live connected tenant.
- Security: token never logged; encrypted at rest; `state` TTL; disconnect revokes.

### A8. Effort

~M (a few days human / a focused session or two for me). The OAuth + storage + read-path is a near-copy of the Meta connection; the net-new is the Slack-specific OAuth exchange, the channel picker, and the settings card.

---

## Option B — Composio-managed Slack (Phase 2, after A)

### B0. Gating spike (do FIRST, before any B code)

Verify Composio actually ships a **Slack toolkit** with a send-message action and per-workspace managed auth: inspect `@composio/core`/`@composio/client`, the Composio dashboard/toolkit catalog, and confirm an action slug (e.g. `SLACK_SEND_MESSAGE`). If absent → **B is a dead end; stop and stay on A.**

### B1. If the spike passes

- Add `'slack'` to `IntegrationPlatform` (`backend/integrations/providers/types.ts`) + the Composio `TOOLKIT_SLUG` map (`composio-config.ts`).
- Require the action slug via env (`COMPOSIO_SLACK_SEND_MESSAGE_ACTION`), per the existing "no guessed slugs" convention.
- Extend `capability-preflight.ts` with a Slack `canSendMessages` capability; extend the publisher/execute path (or a new notify path) to call `composio.tools.execute(slug, { channel, text, blocks })`.
- Per-tenant scope is automatic (`connected_accounts` keyed `(tenant_id, platform)`, pointer only — no tokens in Aries).
- The notifier resolver from A5 gains a Composio branch: if `PUBLISH_PROVIDER`/notify-provider = composio and the tenant has a Composio Slack connection, route through Composio; else fall back to the A native path.

### B2. Why after A, not instead

A is unconditional (no external dependency) and reuses a proven in-repo pattern; B trades "build OAuth" for "depend on Composio + verify its Slack toolkit + extend the provider seam from publishing to notifications." Shipping A first de-risks the feature and gives a fallback if B's spike fails.

---

## Resolved decisions (/plan-eng-review, 2026-06-09)

1. **Scope (v1)**: Full Option A **including** the `conversations.list` channel picker (not deferred). Connect-then-pick is the product-grade UX; the picker is cheap given the OAuth token is already in hand.
2. **Fallback (Issue 1)**: **Per-tenant only; skip when a tenant has no Slack connection** (`{delivered:false, reason:'no_tenant_config'}`, no silent global channel). An **explicit opt-in single-tenant env** (`SLACK_SINGLE_TENANT_CHANNEL` + the existing `SLACK_BOT_TOKEN`) re-enables a global channel for self-hosters/single-tenant installs — never a silent default. Eliminates the PR2 cross-tenant-leak risk while keeping self-host convenient.
3. **Distribution (Issue 2)**: One **unlisted, public-distribution OAuth app** we own; customers install via the "Add to Slack" link from settings. No App Directory review on the critical path; can list later.
4. **Channel storage (folded)**: a `notify_channel_id` + `notify_channel_name` column on `oauth_connections` (one channel/tenant in v1). No separate table — matches the one-row-per-(tenant,provider) model.
5. **Scopes (folded)**: `chat:write` (post) + `channels:read` + `groups:read` (picker). **No `chat:write.public`** — rely on the picked channel + an "invite @Aries" hint on `not_in_channel`.
6. **Dedup (folded)**: alter the `slack_notifications` constraint from PK `dedup_key` to composite `(tenant_id, dedup_key)` — safe on the tiny flag-OFF table.
7. **Sequencing (folded)**: PR [#579](https://github.com/DeliciousHouse/aries-app/pull/579) lands as the single-tenant global-env MVP; Option A is a follow-on PR that adds the per-tenant layer on top (and migrates tenant 15 to a connection, dogfooding the OAuth flow). The `SLACK_SINGLE_TENANT_CHANNEL` env preserves #579's behavior for self-host.

## Data flow (Option A)

```
CONNECT (one-time, per tenant)
  Settings → "Add to Slack" ─▶ /api/integrations/slack/oauth/connect
     └─ store CSRF state (oauth_pending_states, 10m TTL) ─▶ slack.com/oauth/v2/authorize
  Slack redirect ─▶ /api/integrations/slack/oauth/callback
     ├─ verify state (CSRF) ─▶ oauth.v2.access (code→token)
     ├─ dbInsertOAuthToken(provider='slack', xoxb- ENCRYPTED) + team_id→external_account_id
     └─ conversations.list ─▶ channel picker ─▶ persist notify_channel_id on oauth_connections

NOTIFY (per approval gate)
  hermes-callbacks.ts:2040  notifyApprovalRequired({tenantId: doc.tenant_id, ...})
     └─ loadSlackConfigForTenant(tenantId)
          ├─ row present ─▶ {botToken(decrypted), channel}
          ├─ none + SLACK_SINGLE_TENANT_CHANNEL set ─▶ global (opt-in)
          └─ none ─▶ null ─▶ SKIP (reason: no_tenant_config)   ◀── no cross-tenant leak
     └─ alreadyDelivered((tenant_id, dedup_key))? ─▶ postSlackMessage(botToken, channel) ─▶ recordNotified
```

## Test coverage plan (Option A)

```
CODE PATHS                                                  COVERAGE TARGET
[+] slack/oauth/connect.ts                                  authorize URL + state persisted (TTL, scopes)   [GAP unit]
[+] slack/oauth/callback.ts                                 happy(token enc) / oauth.v2.access error /
                                                            state mismatch+expired (CSRF)                    [GAP unit] [→E2E connect]
[+] slack/config-store.ts loadSlackConfigForTenant()        present(decrypt+channel) / absent→null /
                                                            single-tenant-env path / decrypt failure→null    [GAP unit]
[+] notifications.ts (resolver swap)                        resolver→post / null→skip(no_tenant_config) /
                                                            composite dedup isolation (2 tenants, same key)  [GAP unit, extend PR2 suite]
[+] channel picker (conversations.list + select)            maps list→options / empty list / pagination cap  [GAP unit]
[+] channel-integrations-screen.tsx Slack card             connect/connected/disconnect render               [GAP →E2E + screenshot]
[+] migration (provider 'slack' + composite dedup)          additive+idempotent / composite enforced          [GAP migration test]

USER FLOWS                                                  COVERAGE TARGET
- Connect → pick channel → saved (renders in dashboard)     [→E2E] + screenshot-verify (Brendan's bar)
- Disconnect (revoke + null channel)                        [→E2E]
- Approval gate → message lands in the tenant's channel     [→E2E] (requires ARIES_AUTO_APPROVE=0)
- Bot not in channel → "invite @Aries" hint surfaced        [unit + UI]

COVERAGE: target 100% of new code paths; reuse PR2 dispatcher tests via the resolver.
```

## Failure modes (each: test? error-handled? silent?)

- **OAuth callback error / expired state** — test YES, error-handled YES (show a clear "couldn't connect Slack, try again"), silent NO.
- **Token decrypt failure (key rotation)** — resolver returns null → skip + log; not a crash. test YES.
- **`conversations.list` pagination** (large workspace) — cap/cursor; test the cap. Not silent (picker shows what it loaded).
- **`not_in_channel` at send** — best-effort ping lost (logged), surface a reconnect/invite hint in the settings card so it's not silent to the operator. **Borderline-critical**: a lost ping is acceptable (dashboard is source of truth) but the operator must be able to see *why* — the settings hint closes that.
- **Auto-approve ON masks all gates** — not an A failure, but documented: per-tenant Slack only fires when `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=0` (same as PR2).

No failure mode is both untested AND unhandled AND silent → **no critical gaps.**

## NOT in scope

- **Inbound approve-from-Slack** (reaction/reply → resume) — that's the separate PR3 (external webhook mutating prod approvals; own review).
- **Per-stage / multi-channel routing** — v1 is one channel per tenant.
- **App Directory listing** — deferred (unlisted OAuth app first).
- **Composio Slack (Option B)** — Phase 2, gated on the B0 spike.
- **Completion/failure notifications** — PR2 scoped to approval-required only; unchanged here.
- **Slack token refresh/rotation** — Slack bot tokens don't expire; `refresh_token_enc`/`expires_at` stay null.

## What already exists (reuse, do not rebuild)

- `oauth_connections` / `oauth_tokens` / `oauth_pending_states` + `oauth-crypto.ts` (AES-256-GCM) + `getDecryptedAccessTokenContextForTenantProvider` — **reused** for Slack token storage/read.
- `meta/connect.ts` + `callback.ts` connect→exchange→`dbInsertOAuthToken` — **template** for the Slack OAuth module.
- `provider-registry.ts` + `channel-integrations-screen.tsx` — **extended** with a Slack card (no new UI framework).
- PR2 `notifyApprovalRequired` (injectable `tenantId`/`pool`/`clientDeps`) + `slack_notifications` (already has `tenant_id`) + `client.ts` — **reused**; only the credential resolution swaps from env to per-tenant.

## Worktree parallelization

| Lane | Modules | Depends on |
|------|---------|------------|
| A: OAuth + store + migration | `backend/integrations/slack/oauth/`, `migrations/`, `init-db.js`, provider literal sites | — |
| B: settings card + picker UI | `frontend/aries-v1/`, `provider-registry.ts`, `lib/api/integrations.ts` | A's route contract (build against the contract, wire after A lands) |
| C: resolver swap + composite dedup | `backend/integrations/slack/notifications.ts`, `config-store.ts` | A's `config-store` interface |

Execution: **Lane A first** (it defines the store + routes). Then **B and C in parallel** (B = UI, C = backend resolver) — they touch disjoint dirs. A and C both live under `backend/integrations/slack/` so the `config-store.ts` interface is the one coordination point — define it in A.

## Implementation Tasks

Synthesized from this review. Run with Claude Code; checkbox as you ship.

- [ ] **T1 (P1, human ~3h / CC ~25min)** — slack/oauth — Slack OAuth v2 connect + callback (state CSRF, `oauth.v2.access`, encrypted token persist) mirroring `meta/connect.ts`.
  - Files: `backend/integrations/slack/oauth/connect.ts`, `callback.ts`, `app/api/integrations/slack/oauth/{connect,callback}/route.ts`
  - Verify: unit (state TTL, token encrypted, CSRF mismatch) + E2E connect round-trip
- [ ] **T2 (P1, human ~1h / CC ~10min)** — schema — migration: add `'slack'` provider + `notify_channel_id`/`notify_channel_name` columns + alter `slack_notifications` to composite `(tenant_id, dedup_key)`; lockstep `init-db.js`.
  - Verify: idempotent re-run; composite constraint enforced on real PG
- [ ] **T3 (P1, human ~2h / CC ~15min)** — slack/config-store — `loadSlackConfigForTenant(tenantId)` (decrypt + channel; single-tenant-env opt-in; null on absent/decrypt-fail) + swap `notifyApprovalRequired` to use it.
  - Files: `backend/integrations/slack/config-store.ts`, `notifications.ts`
  - Verify: unit (present/absent/env-opt-in/decrypt-fail) + composite dedup isolation
- [ ] **T4 (P1, human ~3h / CC ~25min)** — frontend — Slack card in `channel-integrations-screen.tsx` + `provider-registry.ts` entry + `conversations.list` channel picker + disconnect.
  - Verify: E2E connect→pick→save; **screenshot-verify in Brendan's dashboard**
- [ ] **T5 (P2, human ~30min / CC ~5min)** — docs — CLAUDE.md env section (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`, `SLACK_SINGLE_TENANT_CHANNEL`), `.env.example`, docker-compose `environment:` wiring (the two-place rule).

## Build progress (handoff for a fresh session)

**DONE — Foundation (commit `c28a90b`, typecheck-clean):** Slack registered into the generic provider OAuth framework. Reuses `oauth_connections`/`oauth_tokens`/`oauth_pending_states` unchanged.
- `backend/integrations/provider-registry.ts` — `slack` in `ProviderKey` + `family` + `PROVIDER_REGISTRY` (scopes `chat:write`,`channels:read`,`groups:read`; adapter `slack`).
- `backend/integrations/oauth-db.ts` — `slack` in `DbProvider`.
- `backend/integrations/oauth-provider-runtime.ts` — `PROVIDER_ENV_CONTRACT.slack` (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`) + `slackClientId()`/`slackClientSecret()`/`slackClientCredentials()`.
- `backend/integrations/oauth-authorize-urls.ts` — `case 'slack'` → `https://slack.com/oauth/v2/authorize` (comma-sep `scope`, no PKCE).
- `scripts/init-db.js` + `migrations/20260609020000_slack_oauth_provider.sql` — provider CHECK widened to include `slack`; `notify_channel_id`/`notify_channel_name` columns on `oauth_connections`.

**REFINEMENT vs the plan:** the composite `(tenant_id, dedup_key)` change is **dropped** — `jobId` is a globally-unique UUID so `approval:<jobId>:<stage>` is already tenant-isolated; the composite adds a heavier migration (tenant_id NOT NULL) for no real safety. Keep `slack_notifications` PK = `dedup_key`.

**REMAINING — turn-key against these verified contracts:**
- **T1b (token exchange):** find the per-provider exchange dispatch (start at the generic callback `app/api/auth/oauth/[provider]/callback/route.ts` and `backend/integrations/connect.ts` / `backend/integrations/meta/callback.ts` for the pattern) and add a `slack` branch: POST `https://slack.com/api/oauth.v2.access` (form-encoded `client_id`/`client_secret`/`code`/`redirect_uri`), read `access_token` (bot `xoxb-`) + `team.id`/`team.name`; persist via the token store (`backend/integrations/oauth-tokens-db.ts` + `oauth-token-crypto.ts`) + `dbUpsertConnection(status:'connected', external_account_id:team.id, external_account_name:team.name)`. No refresh/PKCE.
- **T3 (resolver):** `backend/integrations/slack/config-store.ts` `loadSlackConfigForTenant(tenantId)` → read `oauth_connections` (provider `slack`, status `connected`) for `notify_channel_id` + decrypt the bot token via the read path (`getDecryptedAccessTokenContextForTenantProvider`, `backend/integrations/oauth-credentials.ts`); return `{botToken, channel}` | null. If null + `SLACK_SINGLE_TENANT_CHANNEL`+`SLACK_BOT_TOKEN` set → opt-in global. Swap `notifyApprovalRequired` (`backend/integrations/slack/notifications.ts`) from the env reads to this resolver (injected for tests); null → skip (`no_tenant_config`).
- **T4 (picker + card):** `conversations.list` (bot token) → channel options persisted to `notify_channel_id`/`notify_channel_name`; add a Slack card to `frontend/aries-v1/channel-integrations-screen.tsx` (registry already has `slack`). Screenshot-verify in Brendan's dashboard.
- **T5 (docs/env):** per the two-place env rule.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (optional) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 decisions resolved, 5 folded, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (1 settings card — lite) |
| Adversarial | `/code-review` | 2nd opinion | 0 | — | at implementation time |

- **Scope**: Full Option A incl. channel picker (accepted; not reduced).
- **Architecture**: reuse-heavy (per-tenant OAuth store + settings UI + PR2 dispatcher all reused); no new infra/innovation token. Security posture hardened to per-tenant-only with explicit single-tenant opt-in (no silent cross-tenant fallback).
- **Test plan**: full new-path coverage targeted; 0 critical (untested+unhandled+silent) gaps.
- **Outside voice**: skipped — two prior read-only verification workflows (env/code/Slack facts + multi-tenant pattern mapping) already served as independent cross-checks; not re-run to conserve the turn.
- **VERDICT**: ENG CLEARED — ready to implement Option A (then the Option B B0 spike). Design is one settings card; a `/design-review` lite pass at implementation time is sufficient.

NO UNRESOLVED DECISIONS
