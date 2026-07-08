# Multiple business brands per Aries account (brand-per-workspace)

Branch: claude/aries-multi-brand-workspace-ecu6o1
Date: 2026-07-08
Status: DRAFT — for review (autoplan-equivalent scoping pass)

## Problem / why

Tenant 15 (brendan@sugarandleather.com) runs Aries with **Aries AI** branding on its connected social platforms. The parent company, Sugar and Leather, has more products that need their own brand presence and social posting — at minimum **Sequence CRM** and **Sugar and Leather** (the company brand itself). The ask:

1. Add additional brands to one Aries account,
2. with **zero context pollution** between brands — the Aries AI brand kit, taste profile, creative memory, connected socials, and analytics must never bleed into Sequence CRM content or vice versa,
3. gated behind a **membership paywall** so extra brands can't be abused on a free account.

**Is it possible? Yes — and it is ~80% already built, shipped dark.** The multi-workspace membership program (`docs/plans/2026-07-03-multi-workspace-membership.md`, Phases 0–4 merged in PRs #763/#764/#766/#767) plus the fact that every piece of brand state in Aries is keyed by `tenant_id` means "one brand = one workspace" delivers exactly this feature. What remains is verification, a small number of gap-closures, and a deliberate rollout — not a new architecture.

> Note on the prior hold: the 2026-07-03 plan carries "APPROVED… do NOT build yet (Brendan's explicit instruction)". The code was subsequently built and merged dark (flag OFF, byte-identical off-path, golden-pinned). This request — "add additional brands to my workspace" — is the use case that plan exists for, so this plan treats the hold as lifted for the rollout phases below, pending Brendan's sign-off on this doc.

## The architecture decision: brand = workspace (Option A), not `brand_id` threading (Option B)

**Option A — one organization/workspace per brand (RECOMMENDED, this plan).**
Every store that constitutes "brand context" is already keyed by `tenant_id` (= `organizations.id`):

| Store | Key today | Pollution risk if brands shared a tenant |
|---|---|---|
| `brand-kit.json` + materialized logo | file path `generated/validated/<tenantId>/` | one kit per tenant — brands would overwrite each other |
| `business_profiles` | `PRIMARY KEY(tenant_id)` | hard one-row-per-tenant |
| `connected_accounts` | `UNIQUE(tenant_id, platform)` | **one Instagram / one Facebook per tenant, period** |
| `oauth_connections` | `UNIQUE(tenant_id, provider)` | one provider connection per tenant |
| `marketing_taste_profile` / `marketing_taste_signal` | tenant-scoped row (`user_id IS NULL`) | both brands' taste signals would merge into one profile |
| Honcho memory | workspace `aries-tenant-<hmac(tenantId)>`, single hardcoded `peer-brand` peer | definitive pollution — both brands' approved brand findings would write to the same peer |
| `creative_assets` + creative-memory learning loop | `UNIQUE(tenant_id, id)` | creative learning pooled across brands |
| `posts`, `insights_*`, `marketing_schedule` | `tenant_id` (`marketing_schedule` is `PRIMARY KEY(tenant_id)`) | mixed feeds, one shared cadence |

Under Option A, all of these isolate **by construction** — a new brand gets a fresh tenant id, so a fresh brand kit, fresh taste profile, fresh Honcho workspace, fresh creative memory, its own connected IG/FB accounts, its own cadence, its own analytics. No pipeline code changes. The user experiences the brands via the already-built workspace switcher (fast pointer switch, `POST /api/tenant/workspace/switch`, one transaction, no re-login).

**Option B — first-class `brand_id` inside one tenant (REJECTED for v1).**
Requires threading a new key through ~15 tables (several with hard PK/UNIQUE constraints on `tenant_id`), the `generated/validated/<tenantId>/` file-path scheme, the Honcho pseudonym/peer model, `buildBrandKitPayload` → `buildProductionResumeContext` injection chain, the connect layer, all sidecar workers, and every dashboard query. Enormous blast radius across the golden journey for the same user-visible outcome. Only worth revisiting if a future requirement genuinely needs cross-brand sharing inside one tenant (e.g. shared team analytics roll-up), which can also be met later with a read-side aggregation layer.

**UX framing:** in v1 the brands are presented as workspaces in the existing switcher ("Aries AI", "Sequence CRM", "Sugar and Leather"). There is no org-of-orgs "company" grouping layer; the Sugar and Leather umbrella is just how Brendan names/uses the workspaces. A grouping layer is explicitly out of scope (see NOT in scope).

## Verified current state (four read-only research passes, 2026-07-08)

**Already built and merged (dark, `ARIES_MULTI_WORKSPACE_ENABLED=0` in prod):**
- **Membership substrate** — `organization_memberships` (PK `(user_id, organization_id)`, role-on-membership, `invited|active`), append-only `organization_membership_events`, idempotent backfill in `scripts/init-db.js`, lowercase-unique email index. Claims resolution via the single helper `resolveTenantClaimsRow` (`lib/auth-tenant-membership.ts`): flag OFF = byte-identical legacy join (golden-pinned by `tests/auth/tenant-resolution-flag-off-golden.test.ts`); flag ON = membership-backed pointer, role from membership, `workspaceCount` on the session.
- **Workspace switcher** — `components/redesign/layout/workspace-switcher.tsx`, rendered only when flag ON and `workspaceCount > 1`; MRU ordering, pending-invite affordance, stale-workspace 409 interlock (`workspace-guard.tsx` + `x-aries-workspace-id` mutation guard).
- **Switch endpoint** — `POST /api/tenant/workspace/switch` (`backend/tenant/workspace-switch.ts`): one transaction, `FOR UPDATE` on the membership row, pointer + legacy `users.role` mirror move atomically; JWT re-hydrates claims from DB on next request (no token surgery).
- **Create-second-workspace path** — account menu → "Create new workspace" → `/onboarding/start?new=1` (flag-gated, `app-shell-client.tsx:737`) → full onboarding wizard → `resolveTenantForDraftWithMemberships` (`app/onboarding/resume/page.tsx`) **always creates a new org + admin membership** in a transaction that runs the entitlement check.
- **The paywall (Decision 13)** — `assertMultiWorkspaceEntitlement` (`backend/tenant/entitlements.ts`): transactional `SELECT … FOR UPDATE` count of active memberships + `users.plan` read; free = 1 workspace, a 2nd active membership requires `plan='pro'`; denial returns `{allowed:false, code:'multi_workspace_requires_pro'}` → caller rolls back → **HTTP 402** → `/workspace/upgrade` screen (`backend/tenant/workspace-upgrade.ts`, `app/workspace/upgrade/page.tsx`). Enforced at both attach choke points (invite accept + second-workspace create). Plan writer is the manual CLI `scripts/billing/set-user-plan.ts` ('free'|'pro', audited via `plan_granted_at/by`) — deliberately the single seam a future payment processor replaces.
- **Onboarding provisioning** — the `?new=1` flow re-collects Goal → Business → Website → Brand identity → Channels, so a new brand naturally re-scrapes its own website into a fresh `brand-kit.json` (created lazily by the first content job via `extractEnrichAndSaveTenantBrandKit`, 7-day TTL) and writes its own `business_profiles` row. Social connect is per-tenant by construction (`connected_accounts UNIQUE(tenant_id, platform)`) via `/dashboard/settings/channel-integrations`.
- **Test coverage** — flag-off goldens + flag-on suites (`multi-workspace-resolution`, `-adversarial`, `workspace-switch(-security)`, `workspace-invitations-phase2`, `multi-workspace-entitlement-journey`, `second-workspace-create-entitlement.requires-infra`, concurrency suites).

**What does NOT exist (the real gaps this plan closes):**
- **G1 — weekly cadence has no UI and no auto-provisioning.** `marketing_schedule` is `PRIMARY KEY(tenant_id)`, created only by the CLI `scripts/marketing/upsert-marketing-schedule.ts`. A freshly created brand workspace will never post on a cadence until someone shells in. Unacceptable for a self-serve "add a brand" flow.
- **G2 — no payment processor.** `users.plan` exists and is enforced, but the only writer is the manual CLI. "Paywall" today = gate + manual grant. Real checkout is a separate follow-up (the seam is ready).
- **G3 — new workspace lands unconnected.** After `?new=1` onboarding, the dashboard shows the soft `meta_not_connected` banner; connect is a separate settings trip. Acceptable for v1 (same as first-workspace behavior) but the post-onboarding redirect should make the connect step obvious.
- **G4 — rendered-UI verification never happened.** The 2026-07-03 plan's own release criterion (invite → accept → switch on live prod, screenshot-verified) is unmet; the flag has never been ON outside tests.
- **G5 — per-brand plan semantics.** Entitlement counts *active memberships per user* (account-level). For this use case (one owner, 3 brands) that's the same thing, but note: `plan='pro'` today unlocks **unlimited** workspaces. If "pro = up to N brands" tiers are wanted, that's a small predicate change (see Phase 3 decision).

## Rollout phases

### Phase 0 — Substrate verification (no code, no prod writes)

1. Run the full flag-ON test matrix locally: `npm run verify`, the multi-workspace suites, and the requires-infra split (`ARIES_TEST_REQUIRES_INFRA_ENABLED=1` + live Postgres) for `membership-backfill`, `second-workspace-create-entitlement`, `multi-workspace-phase2-concurrency`.
2. Local/staging rendered-UI walkthrough with `ARIES_MULTI_WORKSPACE_ENABLED=1`: sign in → account menu shows "Create new workspace" → `?new=1` onboarding creates org #2 → 402/upgrade screen on a free account → grant pro via `set-user-plan.ts` → creation succeeds → switcher renders and switches → each workspace shows its own business profile and empty connect state. Screenshot each step (only rendered output counts).
3. Confirm the init-db membership backfill has run against prod (it ships in `scripts/init-db.js`, applied on container start) and that tenant 15's three manually-repointed users each have a consistent membership row.

Exit: all suites green + walkthrough screenshots. Effort: S (a session).

### Phase 1 — Gap closure (the only net-new code in this plan)

**1a. Auto-provision `marketing_schedule` at onboarding completion (fixes G1).**
In the resume materialization step (`app/onboarding/resume/page.tsx`, after `updateBusinessProfileWithDiagnostics`), insert the tenant's `marketing_schedule` row — reusing the validated upsert logic from `scripts/marketing/upsert-marketing-schedule.ts` extracted into a shared `backend/marketing/schedule-store.ts` helper (CLI becomes a thin wrapper; single writer preserved). Defaults: business-profile timezone, a deterministic default slot (e.g. Monday 09:00 local), `enabled=true` — a new brand starts posting on cadence as soon as the weekly trigger flag is on, matching the product promise. `ON CONFLICT (tenant_id) DO NOTHING` so re-materialization and existing tenants are untouched. Idempotent, transactional with the profile write.

**1b. Cadence visibility in settings (fixes G1's edit path).**
Minimal settings card under `/dashboard/settings` (settings hub screen): show the workspace's cadence row (day/hour/timezone/enabled) with edit + enable/disable, `tenant_admin`-gated, PATCH route that reuses the same shared upsert helper (preserves omitted fields, same validation as the CLI). No new tables. This is deliberately a small form, not a scheduling product.

**1c. Post-onboarding connect nudge for additional workspaces (fixes G3, small).**
After `?new=1` materialization, land on the same `/dashboard/social-content/<jobId>?welcome=1` destination but ensure the existing `meta_not_connected` banner deep-links to `/dashboard/settings/channel-integrations`. If the banner already links there, 1c is a no-op — verify during Phase 0 walkthrough before writing code.

**1d. Upgrade-screen copy (tiny).**
`/workspace/upgrade` currently frames the gate as "second workspace requires Pro". Reword toward the brand use case ("Additional brand workspaces are a Pro feature") and state the contact/upgrade path (manual grant in v1). No enforcement change.

Tests: unit tests for the shared schedule upsert helper (auto-provision on materialize, conflict no-op, CLI parity), route tests for the settings PATCH (role-gated, tenant-isolated), plus the existing flag-off goldens must stay byte-identical (1a runs only in the resume path, which is inherently flag-split already — assert the flag-OFF resume path is unchanged). Gates: `npm run verify` + `validate:social-content`.

Effort: M (1a/1b are the substance; 1c/1d are trivial).

### Phase 2 — Production rollout for Sugar and Leather (ops, not code)

1. Flip `ARIES_MULTI_WORKSPACE_ENABLED=1` in the prod host `.env` (already wired in `docker-compose.yml` per the two-place rule) and deploy.
2. Rendered-UI verify on prod with Brendan's account **before** any new brand is created: existing tenant 15 behavior unchanged, no switcher rendered (workspaceCount=1), dashboard byte-identical.
3. Grant pro: `tsx scripts/billing/set-user-plan.ts --email brendan3394@gmail.com --plan pro` (audited; confirm the exact account email that owns tenant 15 first — prod sign-in is brendan@sugarandleather.com per the incident narrative).
4. Create the two new brand workspaces via the in-app flow (account menu → Create new workspace): **Sequence CRM** (website URL → fresh brand-kit scrape) and **Sugar and Leather**. Verify each 402-then-succeeds sequence behaves (free-plan denial screenshot taken in Phase 0; prod goes straight through on pro).
5. Per new workspace: connect its own Instagram/Facebook via channel-integrations (each brand needs its own IG/FB assets — one account per platform per tenant), confirm the auto-provisioned cadence row, run one weekly job end-to-end, and screenshot the produced creative to confirm the brand kit that drove it is the *new* brand's (logo, palette, voice) with zero Aries AI leakage.
6. Isolation spot-check on prod data: `marketing_taste_profile`, `posts`, `creative_assets`, `insights_*` rows for the new tenant ids contain only their own brand's artifacts; Honcho workspace ids differ per tenant.

Exit: three live brand workspaces, each publishing independently; the 2026-07-03 plan's Phase 5 (flag retirement) clock starts (2+ incident-free weeks).

### Phase 3 — Follow-ups (separate plans, explicitly deferred)

- **Real payment processor** (Stripe checkout + webhook writing `users.plan` through the `set-user-plan` seam; entitlement enforcement code untouched by design). This is the "membership paywall" endgame; v1's gate + manual grant already prevents abuse.
- **Plan tiers / brand caps** (G5): if "pro = up to N brands" is wanted, extend `assertMultiWorkspaceEntitlement`'s predicate from `plan='pro' → unlimited` to a per-plan max; same choke points, one function.
- **Brand-kit editor**: a dedicated editing surface beyond the partial exposure in the business-profile screen.
- **Cross-brand roll-up view**: read-side aggregation across a user's workspaces (analytics only, no shared write state).
- **Multi-workspace Phase 5** flag retirement, per the original plan's criterion.

## Failure modes (each: handled? test?)

- **Free account creates 2nd workspace** → 402 `multi_workspace_requires_pro`, transaction rolled back, routed to `/workspace/upgrade`. Existing (`multi-workspace-entitlement-journey.test.ts`).
- **Concurrent 2nd-workspace attempts racing the plan check** → `FOR UPDATE` on membership rows serializes; existing concurrency suite.
- **Wrong-workspace mutation from a stale tab** → `x-aries-workspace-id` mismatch → 409 + blocking interlock dialog. Existing.
- **Schedule auto-provision re-runs** (resume re-entry, draft re-materialization) → `ON CONFLICT (tenant_id) DO NOTHING`. New test (Phase 1a).
- **Flag flipped OFF after brands exist** → claims resolution reverts to the legacy pointer; the last-active workspace keeps working, others become unreachable (not corrupted) until re-enable. Acceptable rollback posture; document in the deploy note.
- **New brand's weekly job runs before socials connect** → publish-skip path already handles unconnected tenants (posts synthesized for review only / soft banner); no new failure surface.

## NOT in scope

- `brand_id` inside a tenant (Option B) and any schema change to the ~15 tenant-keyed stores.
- A "company" grouping layer above workspaces.
- Payment processing / checkout (Phase 3; the gate itself ships in v1 via the existing plan column).
- Per-workspace (rather than per-account) plan billing.
- Cross-workspace content sharing or shared creative memory.
- Changes to Hermes, the marketing pipeline injection chain, Honcho pseudonymization, or the connect layer — Option A requires none.

## What already exists (reuse, do not rebuild)

`lib/auth-tenant-membership.ts` (claims + org creation), `backend/tenant/{entitlements,workspace-switch,workspace-switcher,workspace-upgrade,workspace-invitations}.ts`, `app/api/tenant/workspace/switch/route.ts`, `components/redesign/layout/{workspace-switcher,workspace-guard,app-shell-client}.tsx`, `app/workspace/{choose,upgrade}/`, `app/onboarding/resume/page.tsx` (`resolveTenantForDraftWithMemberships`), `scripts/billing/set-user-plan.ts`, `scripts/marketing/upsert-marketing-schedule.ts` (validation logic to extract), the entire tenant-keyed isolation model.

## Effort summary

| Phase | Size | Nature |
|---|---|---|
| 0 — verification | S | tests + walkthrough, no code |
| 1 — gap closure | M | schedule auto-provision + settings card + copy |
| 2 — prod rollout | S | ops + rendered-UI verification |
| 3 — follow-ups | — | separate plans |

Total to "Brendan has three isolated, posting brand workspaces behind the pro gate": roughly one focused build session for Phase 1 plus two verification passes.
