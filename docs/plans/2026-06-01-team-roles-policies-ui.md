# Team Roles & Approval Policies in the Operator UI

> Status: draft plan (2026-06-01). Roadmap area #14 (priority 7, Phase 3 "feature depth"). Sequenced **after** the core approval/publish/memory surfaces exist so that every policy hook attaches to a real enforcement point, not a stub. This plan **expands the role model** (3 → a richer set) and adds **member-management + role-assignment UI** plus **per-tenant approval policy config** — "only admin can publish", "client must approve strategy", "generated video always requires approval", "memory candidates require owner approval", "interns can draft but not publish".

## Context

Aries today has exactly **three** tenant roles — `tenant_admin | tenant_analyst | tenant_viewer` (`lib/tenant-context.ts:6`) — duplicated as a literal set in four more places (`lib/auth-tenant-membership.ts:15`, `backend/tenant/user-profiles.ts:25`, `types/next-auth.d.ts:10`, `auth.ts`). There is no Approver / Strategist / Operator / Reviewer distinction, no `/admin/members` or `/admin/roles` page (the settings dir holds only `business-profile` and `channel-integrations`), and authorization is enforced by scattered raw string checks (`tenantContext.role !== 'tenant_admin'`) in individual route handlers — there is no single policy seam.

There are, however, two large pieces already built that this plan **reuses rather than rebuilds**:

1. **A complete, tested-in-isolation RBAC layer that is currently dead code.** `backend/auth/permission-check.ts` already defines a **7-role** model (`platform_owner`, `platform_operator`, `tenant_admin`, `tenant_analyst`, `tenant_viewer`, `automation_service`, `security_auditor`), a `PERMISSIONS` enum, a `ROLE_GRANTS` map, an `OPERATION_PERMISSIONS` table (including `tenantAdminInviteMember`, `tenantAdminUpdateMemberRole`, `tenantAdminUpdateSettings` → `rbac.policy.manage`), and `evaluatePermissionDecision()`. `backend/auth/rbac.ts` wraps it with tenant-boundary checks and a `createRbacMiddleware()` factory. **Neither module is imported by any route handler** (`grep -rln "auth/rbac"` outside the module returns nothing; `permission-check.ts` and `tenant-guard.ts` are imported only by `rbac.ts`). The real routes still do raw string comparisons, and the `Role` enum here (7 roles) is divergent from the live `TenantRole` enum (3 roles).
2. **Member-management CRUD already exists.** `backend/tenant/user-profiles.ts` provides `listTenantUserProfiles` / `createTenantUserProfile` / `updateTenantUserProfile` / `deleteTenantUserProfile`, surfaced through `app/api/tenant/profiles/route.ts` (GET/POST, admin-gated) and `app/api/tenant/profiles/[userId]/route.ts` (GET/PATCH/DELETE, admin-gated). The settings screen (`frontend/aries-v1/settings-screen.tsx:190-217`) already renders a read-mostly **"Team / Approvals"** panel and a `launchApproverUserId` selector backed by `business_profiles.launch_approver_user_id` (`scripts/init-db.js:155`).

So the gap is **not** "build RBAC from scratch." It is: (a) **reconcile** the two role enums into one expanded, persisted role set; (b) **build the operator-facing UI** for members and roles; (c) **introduce a per-tenant approval-policy store** and a **single enforcement seam** that the existing publish/approve/memory/video surfaces consult; (d) ship it all **default-OFF** so production authorization behavior is byte-identical until a tenant admin opts in.

This is **behavioral and user-facing**, so it ships behind `ARIES_TEAM_POLICIES_ENABLED` (default OFF). When OFF, every route falls back to today's exact `role !== 'tenant_admin'` checks; the new pages render read-only informational copy; no policy is enforced. This guarantees a zero-behavior-change deploy on the live single-tenant prod box.

## Who cares

- **Operators / the @sugarandleather tenant** — today there is one real admin and no way to invite a teammate with "can draft, cannot publish" or "must approve strategy" rights. Roles + policies are table stakes for a multi-person account.
- **Product / public readiness** — roadmap #14 is the headline "safety-first, approval-gated, traceable" promise expressed as configurable governance, not just a hardcoded gate.
- **Eng** — the dead RBAC layer (`backend/auth/*`) is a latent correctness hazard: a second role enum that disagrees with the live one. Either wire it in or delete it; this plan wires it in.

## Decisions (locked — do not re-litigate)

1. **One role enum, expanded.** Collapse the divergent enums into a single tenant-facing set. The expanded **tenant** roles are: `tenant_admin`, `tenant_strategist`, `tenant_operator`, `tenant_approver`, `tenant_reviewer`, `tenant_analyst` (retained, legacy alias), `tenant_viewer`. The platform/service roles already in `permission-check.ts` (`platform_owner`, `platform_operator`, `automation_service`, `security_auditor`) stay where they are — out of the tenant-facing UI, in the RBAC grant map only. **`tenant_analyst` is retained as a live value** so existing seeded users keep working; the migration does not rename it.
2. **Additive, backward-compatible enum widening.** Per CLAUDE.md memory *"Widening union → grep inequalities"* (this exact class of bug shipped 3× in v0.1.11.x): every site that does `=== 'tenant_admin'` / `!== 'tenant_admin'` / `=== 'tenant_analyst'` etc. must be found by grep, because TS will **not** flag a now-incomplete literal inequality. (Verified: there are currently 10 such inequality sites across `app`/`backend`/`lib`.) Phase A is a dedicated reconciliation pass whose only job is to inventory and centralize these checks behind one helper before any new role can be assigned.
3. **Policy is per-tenant config, enforcement is one seam.** A new `tenant_approval_policies` table (one row per tenant, JSONB policy doc) plus a `backend/auth/policy-store.ts` reader and a single `backend/auth/enforce-policy.ts` decision function. Routes call **one** function (`evaluateTenantActionPolicy`), not bespoke inline logic. This is the only way to keep the publish/approve/memory/video gates consistent.
4. **Policies never weaken existing hard gates — they only add gates.** `app/api/publish/dispatch/handler.ts` already enforces an approval-record gate before any Meta side-effect (`validateAndConsumeApproval`), and `inv-07-publishing-requires-approval` / `inv-08-video-render-requires-approval` are REQUIRED suite invariants. A policy can require *more* approval (e.g. "client must approve strategy", "only admin can publish") but can **never** let an unapproved publish through. Default-deny on policy ambiguity.
5. **Flag-gated, default OFF.** `ARIES_TEAM_POLICIES_ENABLED`. When unset/off: role enum still widens (additive, harmless) but **no new role can be assigned via UI**, **no policy is read or enforced**, and all routes use the legacy `tenant_admin`-only checks. The new pages render but show "Team policies are not enabled for this tenant." This makes the deploy a no-op until explicitly switched on per the operator's readiness.
6. **No autonomous publish, ever.** `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` interaction is explicit: when an approval policy is ON and requires a human approver, auto-approve must be **suppressed** for that stage (a policy that says "client must approve strategy" overrides the autonomous bypass). Default-deny wins.
7. **Reuse the dead RBAC layer; do not fork it.** `backend/auth/permission-check.ts` + `rbac.ts` + `tenant-guard.ts` become live. The new expanded tenant roles are added to `ROLES` / `ROLE_GRANTS` there; `evaluatePermissionDecision` becomes the backing implementation for the centralized role helper.

## Current State (VERIFIED — branch @ fix/story-composer-serving)

**Role enum (3 roles, duplicated):**
- `lib/tenant-context.ts:6` — `export type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';`
- `lib/auth-tenant-membership.ts:15` — `const TENANT_ROLES = new Set<TenantRole>(["tenant_admin","tenant_analyst","tenant_viewer"]);` + `LOCAL_DEV_DEFAULT_TENANT_ROLE = "tenant_admin"`.
- `backend/tenant/user-profiles.ts:25` — same 3-role `Set`, `assertTenantRole` throws `invalid_role` for anything else.
- `types/next-auth.d.ts:10,21` — `role?: TenantRole` on session + `tenantRole?` on JWT.
- `auth.ts` — JWT/session enrichment casts `row.role as TenantRole` and guards with `isTenantRole`.
- `scripts/init-db.js:31,39` — `users.role TEXT NOT NULL DEFAULT 'tenant_admin'` (free text column — no DB-side CHECK constraint, so widening is schema-safe).

**Dead RBAC layer (7 roles, not wired):**
- `backend/auth/permission-check.ts` — `ROLES` (7), `PERMISSIONS` (14), `ROLE_GRANTS`, `OPERATION_PERMISSIONS` (incl. `tenantAdminInviteMember`, `tenantAdminUpdateMemberRole`, `tenantAdminUpdateSettings`), `evaluatePermissionDecision()`. **Imported only by `backend/auth/rbac.ts`.**
- `backend/auth/rbac.ts` — `evaluateRbac()`, `createRbacMiddleware()`, `SERVICE_ACTOR_BYPASS_TENANT_CLAIM_ROLES`. **Imported by nothing.**
- `backend/auth/tenant-guard.ts` — `evaluateTenantBoundary()`, `TENANT_SCOPED_ROLES` (the same 3 tenant roles), `CROSS_TENANT_ALLOWED_ROLES`. **Imported only by `backend/auth/rbac.ts`.**

**Member management (exists, admin-gated, no UI page):**
- `backend/tenant/user-profiles.ts` — full CRUD against `users` (insert uses `password_hash='invited_pending'`).
- `app/api/tenant/profiles/route.ts` — GET (any member) + POST (`role !== 'tenant_admin'` → 403 at line 38). POST accepts `role?: 'tenant_admin'|'tenant_analyst'|'tenant_viewer'` (line 42 — **literal-typed, must widen**).
- `app/api/tenant/profiles/[userId]/route.ts` — GET/PATCH/DELETE, PATCH+DELETE gated `role !== 'tenant_admin'` (lines 54, 112). PATCH body `role?:` literal-typed (line 58 — **must widen**).
- `frontend/aries-v1/settings-screen.tsx:190-217` — "Team / Approvals" panel: read-only member rows + `launchApproverUserId` `<select>`. `hooks/use-business-profile.ts` exposes `team` (calls `/api/tenant/profiles`).
- Tests: `tests/tenant/user-profiles-isolation.test.ts` (cross-tenant isolation), `tests/hook-request-loops.test.ts`.

**Approval / publish / memory enforcement points (the policy hook targets):**
- **Publish:** `app/api/publish/dispatch/handler.ts` — `validateAndConsumeApproval()` gate (line 99) before any Meta Graph call; consumes a `marketing_approval_record` atomically under a file lock. The role is already on `tenantResult.tenantContext.role` (lines 375/460). The natural hook for "only admin can publish" / "interns can draft but not publish."
- **Approve:** `app/api/marketing/jobs/[jobId]/approve/handler.ts` → `approveSocialContentJob` / `denySocialContentJob` (`backend/marketing/orchestrator.ts`). Approval steps (verified at handler.ts:19-24): `approve_weekly_plan` (→ strategy), `approve_post_copy|approve_image_creatives|approve_video_script|approve_video_render` (→ production), `approve_publish` (→ publish). The hook for "client must approve strategy."
- **Auto-approve bypass:** `backend/marketing/hermes-callbacks.ts:1035` `autoApproveMarketingPipelineEnabled()` — must be policy-suppressed when a stage requires a human approver.
- **Video:** `backend/marketing/synthesize-publish-posts.ts:115` `isVideoPublishEnabled()` (`ARIES_VIDEO_PUBLISH_ENABLED`); video render approval step `approve_video_render`. The hook for "generated video always requires approval."
- **Memory:** `backend/memory/curator.ts` `curateFinding()` → `auto_approve | queue_for_review | drop` (verified at curator.ts:84-135); `app/api/tenant/research/review-queue/route.ts` (admin-gated, `role !== 'tenant_admin'` at line 18). The hook for "memory candidates require owner approval."
- **Invariant tests that must stay green:** `tests/prd-invariants/inv-07-publishing-requires-approval.test.ts`, `inv-08-video-render-requires-approval.test.ts`, `inv-09-ai-content-draft-until-approved.test.ts`, `inv-01b-state-mutating-routes-auth-gate.test.ts` (all in the REQUIRED `full-suite` gate and the fast verify suite, `scripts/verify-regression-suite.mjs:68-83`).

**Nav / page wiring:**
- `frontend/app-shell/routes.ts` — `AppRouteId` union (ends at `'settings'`, line 15) + `APP_ROUTES`; `'settings'` → `/dashboard/settings`. Routes carry `section: 'primary' | 'utility'`. New route ids register here.
- `app/dashboard/settings/page.tsx` → `AriesSettingsScreen`. No `/admin/members` or `/admin/roles` page exists (`app/admin/` holds only `app/admin/marketing/jobs/[jobId]/debug/page.tsx`).

## Architecture (target)

```
                          ┌─────────────────────────────────────────────┐
                          │  ONE role enum (lib/tenant-context.ts)        │
                          │  tenant_admin | tenant_strategist |           │
                          │  tenant_operator | tenant_approver |          │
                          │  tenant_reviewer | tenant_analyst(legacy) |   │
                          │  tenant_viewer                                │
                          └───────────────┬─────────────────────────────┘
                                          │ (single source; re-exported to
                                          │  auth.ts, next-auth.d.ts,
                                          │  user-profiles, permission-check)
        ┌─────────────────────────────────┼──────────────────────────────────┐
        ▼                                  ▼                                   ▼
  MEMBER MGMT UI                    backend/auth/                       POLICY CONFIG UI
  /admin/members                    role-helpers.ts  (NEW)              /admin/roles
  (invite, assign role)             can(role, action) ──┐               (toggle policies)
        │                           wraps permission-check │                    │
        ▼                                                  ▼                    ▼
  app/api/tenant/profiles/*         backend/auth/enforce-policy.ts (NEW)  app/api/tenant/policies
  (widen role literals)             evaluateTenantActionPolicy({          (GET/PUT, admin-gated)
                                      tenantId, role, action, stage })          │
                                          │   reads ▼                           ▼
                                          │   backend/auth/policy-store.ts  tenant_approval_policies
                                          │   (NEW; per-tenant JSONB)       (NEW table, 1 row/tenant)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                            ▼                           ▼
   publish/dispatch/handler.ts   marketing/.../approve/handler.ts   curator.ts / review-queue
   "only admin can publish"      "client must approve strategy"     "memory needs owner approval"
   "interns draft not publish"   suppress auto-approve bypass       synthesize: "video always approve"
              │                            │                           │
              └────── ALL gated by ARIES_TEAM_POLICIES_ENABLED (default OFF → legacy behavior) ──────┘
```

When `ARIES_TEAM_POLICIES_ENABLED` is OFF, `evaluateTenantActionPolicy` returns `{ allow: true, addedGates: [] }` unconditionally and `can()` falls back to the legacy `role === 'tenant_admin'` test — production behavior is unchanged.

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Role enum reconciliation: widen `TenantRole`, centralize every role check behind `role-helpers.ts`, grep-sweep inequalities, migration-free (free-text column) | Critical | 4h / 1.5h | none |
| B | Member-management UI: `/admin/members` page reading existing CRUD; widen role literals in profile routes | High | 4h / 1.5h | A |
| C | Policy store + table + enforcement seam (`enforce-policy.ts`), default-OFF flag, no UI yet | High | 5h / 2h | A |
| D | Policy config UI: `/admin/roles` page (toggle the 5 named policies) + GET/PUT route | High | 4h / 1.5h | C |
| E | Wire enforcement into publish / approve / memory / video surfaces; suppress auto-approve when policy requires human | High | 5h / 2h | C |
| F | Flag, docs, full-suite + live operator-dashboard verification, ship | Medium | 3h / 1h | B, D, E |

**Sequencing:** A first and alone (the union-widening grep sweep is the highest-risk step and everything else depends on the centralized helper). B and C parallel after A. D after C (UI needs the store). E after C (enforcement needs the seam). F last.

```
A ─┬─> B ──────────────┐
   └─> C ─┬─> D ────────┼─> F
          └─> E ────────┘
```

---

### A — Role enum reconciliation (Critical, 4h)

**This phase changes no behavior and assigns no new role.** Its only deliverable is: one widened enum, one helper, zero stale literal-inequality checks.

**Implementation:**
1. `lib/tenant-context.ts:6` — widen:
   ```ts
   export type TenantRole =
     | 'tenant_admin'
     | 'tenant_strategist'
     | 'tenant_operator'
     | 'tenant_approver'
     | 'tenant_reviewer'
     | 'tenant_analyst'   // legacy — retained for already-seeded users
     | 'tenant_viewer';
   ```
2. Centralize the role set: add `export const TENANT_ROLES: readonly TenantRole[]` in `lib/tenant-context.ts` and have `lib/auth-tenant-membership.ts:15`, `backend/tenant/user-profiles.ts:25` **import** it instead of re-declaring their own `Set`. `isTenantRole` derives from the shared set.
3. **New `backend/auth/role-helpers.ts`** — the single authorization predicate used by every route:
   ```ts
   export type TenantAction =
     | 'member.manage' | 'policy.manage'
     | 'strategy.approve' | 'production.approve' | 'publish.approve'
     | 'publish.dispatch' | 'memory.approve' | 'video.approve';
   export function can(role: TenantRole, action: TenantAction): boolean
   ```
   Backed by `permission-check.ts`'s `evaluatePermissionDecision` (Phase C extends `ROLE_GRANTS`). **When `ARIES_TEAM_POLICIES_ENABLED` is OFF, `can()` collapses to legacy semantics: `action.endsWith('.manage') || action.endsWith('.approve') || action === 'publish.dispatch'` ⇒ `role === 'tenant_admin'`** — byte-identical to today's scattered checks.
4. Extend `backend/auth/permission-check.ts` `ROLES` + `ROLE_GRANTS` with the 4 new tenant roles (grants per the policy matrix in Phase C). `tenant_analyst` keeps its current grants (note: `tenant_analyst` does **not** currently hold `marketing.job.approve` — do not add it; preserve the existing grant set exactly).
5. **Grep sweep (the load-bearing step).** Per CLAUDE.md memory, run and resolve every hit (there are currently 10 `tenant_admin` inequality sites across `app`/`backend`/`lib`):
   ```
   grep -rn "=== 'tenant_admin'\|!== 'tenant_admin'\|=== \"tenant_admin\"\|!== \"tenant_admin\"" app backend lib
   grep -rn "=== 'tenant_analyst'\|!== 'tenant_analyst'\|=== 'tenant_viewer'\|!== 'tenant_viewer'" app backend lib
   ```
   Each hit either (a) routes through `can()` now, or (b) is annotated `// legacy-admin-only: intentional` if it is a true admin-only operation unaffected by roles. No raw inequality may silently mis-classify a new role as "not viewer" / "is admin."

**Acceptance:** `npm run typecheck` clean; `isTenantRole('tenant_approver') === true`; every grep hit above is either centralized or annotated; **`npm run verify` and the full invariant suite pass with zero behavior change** (no new role exists in any seed row yet).

### B — Member-management UI (High, 4h)

**Reuses the existing CRUD; adds the page.**

**Implementation:**
1. Widen the literal role types in `app/api/tenant/profiles/route.ts:42` and `app/api/tenant/profiles/[userId]/route.ts:58` from the 3-value inline union to `TenantRole` (import from `lib/tenant-context`). `createTenantUserProfile` / `updateTenantUserProfile` already validate via `assertTenantRole`, which now accepts the widened set.
2. **New `frontend/aries-v1/team-members-screen.tsx`** — full member table: email, name, role `<select>` (the 7 tenant-facing values), invite form (POST `/api/tenant/profiles`), remove (DELETE). Renders the existing `useBusinessProfile().team` data; admin-only actions disabled for non-admins. When `ARIES_TEAM_POLICIES_ENABLED` is OFF, the role `<select>` is limited to the legacy 3 values + a "Enable team policies to use more roles" hint (the new roles do nothing without enforcement, so do not let an operator assign a role that has no effect).
3. **New `app/admin/members/page.tsx`** → `AppShellLayout currentRouteId="teamMembers"` wrapping the screen.
4. `frontend/app-shell/routes.ts` — add `'teamMembers'` to `AppRouteId` + an `APP_ROUTES` entry (`/admin/members`, section `'utility'`, title "Team & Roles"). **Grep-verify** no `switch (routeId)` elsewhere is now non-exhaustive (same union-widening discipline).
5. Expose member count / "Manage team" link from the settings "Team / Approvals" panel (`settings-screen.tsx:190`) → `/admin/members`.
6. Add a client gate: `app/admin/members/page.tsx` resolves tenant context server-side and 404s for non-members (mirror `app/admin/marketing/jobs/[jobId]/debug/page.tsx` pattern).

**Acceptance (user-visible, rendered UI only):** logged in as the @sugarandleather admin, `/admin/members` renders the real member list from the live DB; an admin can invite a member with role `tenant_approver`, the row appears, and a reload still shows it; a `tenant_viewer` session sees the list read-only (no invite/remove controls). With the flag OFF, only legacy roles are selectable.

### C — Policy store + enforcement seam (High, 5h)

**Implementation:**
1. **New migration `migrations/20260601120000_tenant_approval_policies.sql`** (additive, idempotent):
   ```sql
   CREATE TABLE IF NOT EXISTS tenant_approval_policies (
     tenant_id   INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
     policy      JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_by  INTEGER REFERENCES users(id),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```
   Mirror in `scripts/init-db.js` for fresh installs. (Naming + `REFERENCES organizations(id)` match the existing migration convention.)
2. **New `backend/auth/policy-store.ts`** — `loadTenantPolicy(client, tenantId): TenantApprovalPolicy` (returns a fully-defaulted doc when the row is absent — **absent = no policy = legacy behavior**) and `saveTenantPolicy(...)`. The doc shape:
   ```ts
   type TenantApprovalPolicy = {
     onlyAdminCanPublish: boolean;          // default false
     clientMustApproveStrategy: boolean;    // default false
     generatedVideoAlwaysRequiresApproval: boolean; // default false
     memoryCandidatesRequireOwnerApproval: boolean; // default false
     internsCanDraftNotPublish: boolean;    // default false  (interns == tenant_operator/tenant_reviewer)
   };
   ```
3. **New `backend/auth/enforce-policy.ts`** — `evaluateTenantActionPolicy({ tenantId, role, action, stage, policy }): { allow: boolean; deny_reason?: string; requiresHumanApprover?: boolean }`. **Default-deny on ambiguity**; **never returns `allow:true` for a publish that the existing approval-record gate would block** (it only adds constraints). When `ARIES_TEAM_POLICIES_ENABLED` is OFF, returns `{ allow: true }` unconditionally.
4. **Role grant matrix** (added to `permission-check.ts` `ROLE_GRANTS`): `tenant_strategist` → strategy approve + draft, no publish; `tenant_operator` → draft/schedule, publish only if policy `internsCanDraftNotPublish === false`; `tenant_approver` → strategy/production/publish approve + memory approve; `tenant_reviewer` → review/comment, no approve, no publish; `tenant_admin` → all. Encode the named policies as overlays on top of the base grant.

**Acceptance:** unit table on `evaluateTenantActionPolicy` — flag OFF ⇒ always allow; flag ON + `onlyAdminCanPublish` + `role=tenant_operator` + `action=publish.dispatch` ⇒ deny; `clientMustApproveStrategy` + strategy stage ⇒ `requiresHumanApprover:true`; absent policy row ⇒ all-allow. No DB read when flag OFF (cheap path).

### D — Policy config UI (High, 4h)

**Implementation:**
1. **New `app/api/tenant/policies/route.ts`** — GET (any member, returns the defaulted policy doc) + PUT (`can(role,'policy.manage')` → admin, persists via `saveTenantPolicy`, records `updated_by`). Literal error codes only (mirror `app/api/tenant/profiles/route.ts:62-70` CodeQL-safe pattern).
2. **New `frontend/aries-v1/team-policies-screen.tsx`** — five labelled toggles, one per named policy, each with plain-English helper copy ("Only admins can publish to connected channels", "A client/approver must sign off on strategy before production", "Generated video always requires a human approval before publish", "Memory candidates require owner approval before they are remembered", "Operators/interns can draft and schedule but cannot publish"). Save button → PUT. When `ARIES_TEAM_POLICIES_ENABLED` is OFF, toggles are disabled with a banner: "Team policies are not enabled for this tenant."
3. **New `app/admin/roles/page.tsx`** → `AppShellLayout currentRouteId="teamPolicies"` (or co-locate with `/admin/members` as a tabbed screen — single nav entry "Team & Roles"). Register route id in `routes.ts`.
4. Show the **effective role → permission matrix** read-only on the same page so an admin can see what each role can do (rendered from `ROLE_GRANTS` + active policy overlays) — this is the "transparency" half of the roadmap item.

**Acceptance (user-visible):** as admin, `/admin/roles` renders all five toggles reflecting the live `tenant_approval_policies` row; flipping "Only admins can publish" and saving persists (reload shows it ON); the read-only role matrix updates to show `tenant_operator` lost `publish.dispatch`. Flag OFF ⇒ toggles disabled + banner.

### E — Wire enforcement into the real surfaces (High, 5h)

Each hook is **guarded by `ARIES_TEAM_POLICIES_ENABLED`** and **additive** (never weakens an existing gate).

**Implementation:**
1. **Publish** (`app/api/publish/dispatch/handler.ts`): after the existing `validateAndConsumeApproval` succeeds (do **not** move it — the approval-record gate stays first), call `evaluateTenantActionPolicy({ tenantId, role, action:'publish.dispatch' })`. On deny → 403 `{ reason:'publish_blocked_by_policy' }`. This enforces `onlyAdminCanPublish` + `internsCanDraftNotPublish`. The role is already on `tenantResult.tenantContext.role`.
2. **Strategy approval** (`app/api/marketing/jobs/[jobId]/approve/handler.ts`): when `clientMustApproveStrategy` and the resolving step maps to `strategy` (`approve_weekly_plan`), require `can(role,'strategy.approve')`; deny `tenant_operator`/`tenant_viewer`. Surface `reason:'approval_requires_approver_role'`.
3. **Auto-approve suppression** (`backend/marketing/hermes-callbacks.ts`): wrap `autoApproveMarketingPipelineEnabled()` so that for a stage whose policy `requiresHumanApprover === true`, the autonomous bypass is **suppressed** (the run waits for a human). This is the decision-6 guardrail in code: a policy that demands a human always beats the auto-approve flag.
4. **Video** (`backend/marketing/synthesize-publish-posts.ts` / approve handler `approve_video_render` step): when `generatedVideoAlwaysRequiresApproval`, force the `approve_video_render` checkpoint to be human-resolved even if auto-approve is on. (Reconcile with `ARIES_VIDEO_PUBLISH_ENABLED` — this only matters when video publish is also enabled.)
5. **Memory** (`backend/memory/curator.ts` / `app/api/tenant/research/review-queue/route.ts`): when `memoryCandidatesRequireOwnerApproval`, force `curateFinding` outcomes that would `auto_approve` to `queue_for_review` instead, so they land in the existing admin review queue. Do not bypass the curator's hard-reject list.

**Acceptance:** with flag ON + each policy, a fixture-level integration test proves the *added* gate fires (operator publish → 403; strategy approve by operator → 403; auto-approve suppressed for client-must-approve strategy; auto-approve video forced to human checkpoint; first-party memory finding queued instead of auto-approved). With flag OFF, all five paths behave exactly as today (the invariant suite proves no regression).

### F — Flag, docs, verify, ship (Medium, 3h)

**Implementation:**
1. `ARIES_TEAM_POLICIES_ENABLED` (default OFF): document in `CLAUDE.md` "Environment Variables", `.env.example` (`ARIES_TEAM_POLICIES_ENABLED=0`), and `docker-compose.yml` (default `0`, e.g. `ARIES_TEAM_POLICIES_ENABLED: ${ARIES_TEAM_POLICIES_ENABLED:-0}`).
2. Live operator-dashboard walkthrough on the @sugarandleather tenant: `/admin/members` renders real members; assign + reload persists; `/admin/roles` toggles persist; flip "only admin can publish" ON and confirm a non-admin publish attempt is blocked **in the UI**, then flip OFF and confirm normal flow.
3. `/ship-triage-deploy`; bump `VERSION` (minor — new table + route + expanded enum) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ both pages render the "not enabled" state, zero enforcement, full-suite green; flag ON ⇒ all five policies enforce + render correctly in Brendan's dashboard (per memory: only rendered UI counts as done); `full-suite` REQUIRED gate green.

## User-visible success bar (rendered UI only)

Done means, in the operator dashboard on the live @sugarandleather tenant:
1. `/admin/members` lists real members from the live DB; an admin invites a teammate as `tenant_approver`, the row renders, and persists across reload.
2. `/admin/roles` renders five policy toggles backed by `tenant_approval_policies`; saving a toggle persists across reload; a read-only role→permission matrix renders.
3. With the flag ON and "Only admins can publish" set, a non-admin session is visibly blocked from publishing (403 surfaced in the UI), and an admin still publishes normally.
4. With the flag OFF, both pages render the disabled "Team policies are not enabled" state and **nothing about today's publishing/approval behavior changes** (proven by the green invariant suite).

DB rows, state files, and passing mocks do **not** count — only the rendered dashboard states above.

## Feature Flag

- **`ARIES_TEAM_POLICIES_ENABLED`** — rollout switch for expanded roles + per-tenant approval policies. Aries treats `1`, `true`, `yes`, or `on` as enabled. **Default OFF.** When OFF: the `TenantRole` enum is widened (additive, harmless) but the member UI restricts assignable roles to the legacy `tenant_admin`/`tenant_analyst`/`tenant_viewer` set, `evaluateTenantActionPolicy` returns allow-all without reading the DB, and every publish/approve/memory/video route uses today's exact `role === 'tenant_admin'` checks — production authorization is byte-identical. When ON: the four new tenant roles become assignable, `tenant_approval_policies` is read per request, and the five named policies (`onlyAdminCanPublish`, `clientMustApproveStrategy`, `generatedVideoAlwaysRequiresApproval`, `memoryCandidatesRequireOwnerApproval`, `internsCanDraftNotPublish`) add — never remove — approval gates. A policy that requires a human approver suppresses `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` for that stage. Policies can never let an unapproved publish through (`validateAndConsumeApproval` stays first). Ship default OFF and leave it OFF on the single-tenant prod box until the operator opts in.

## Data / contract changes

- **New table `tenant_approval_policies`** (Phase C) — one JSONB row per tenant; absent row = all-default = legacy behavior. Additive + idempotent migration; mirrored in `scripts/init-db.js`. References `organizations(id)` (verified table name).
- **`TenantRole` union widened** (Phase A) — additive; `users.role` is a free-text column (`scripts/init-db.js:31`, no CHECK), so **no data migration is needed**; existing rows keep their values.
- **No change** to `marketing_approval_record` shape, the publish dispatch body, or the Hermes callback contract. Policy enforcement is a pre-check layered on existing flows.

## Test + CI-exact verify steps

| Layer | What | Count |
|-------|------|-------|
| Unit | `isTenantRole` accepts all 7 widened roles; rejects junk | +2 |
| Unit | Grep-sweep guard: a new test asserts no raw `=== 'tenant_admin'` outside annotated allowlist (mirrors `inv-01b` style) | +1 |
| Unit | `can(role, action)` matrix: each role × each `TenantAction`, flag ON vs OFF | +8 |
| Unit | `evaluateTenantActionPolicy`: flag OFF allow-all; absent row allow-all; each of 5 policies deny/require-human | +7 |
| Unit | `policy-store` load defaults when row absent; save round-trips JSONB | +3 |
| Integration | profile routes accept widened role; cross-tenant isolation preserved (extend `tests/tenant/user-profiles-isolation.test.ts`) | +3 |
| Integration | publish dispatch: flag ON + `onlyAdminCanPublish` + operator ⇒ 403; admin ⇒ proceeds; flag OFF ⇒ unchanged | +3 |
| Integration | approve handler: `clientMustApproveStrategy` + operator strategy approve ⇒ 403; approver ⇒ ok | +2 |
| Integration | auto-approve suppressed when policy requires human; restored when OFF | +2 |
| Integration | memory curator: `memoryCandidatesRequireOwnerApproval` forces auto-approve→queue | +2 |
| Regression | `inv-07`, `inv-08`, `inv-09`, `inv-01b` stay green with flag OFF **and** ON | run existing |
| E2E (live, manual) | `/admin/members` + `/admin/roles` render + persist on @sugarandleather; policy-blocked publish visible in UI | manual |

New test files allowlisted in `scripts/verify-regression-suite.mjs`. All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify` then `npm run test:concurrent` before ship (touches routes + backend + shared role helper + auth). Run `npm run lint` (banned-pattern + typecheck) — the widened union must typecheck cleanly with no new banned strings. Run `npm run guardrails:agent` before opening the PR (parallel-worktree duplicate-work guard).

## Resumability / idempotency

- The policy table write (Phase D) is a single idempotent UPSERT keyed on `tenant_id`; re-saving the same toggles is a no-op.
- Policy enforcement is a stateless pre-check — it reads the policy and the role and decides; it persists nothing, so there is no partial-write to resume.
- The publish gate ordering is preserved: `validateAndConsumeApproval` consumes the approval record atomically under its file lock **before** the policy pre-check could ever change behavior; a policy deny happens *before* any Graph side-effect, so a blocked publish leaves no half-published state.
- Member invite reuses the existing CRUD, which is a single INSERT — already idempotent-safe at the route level (duplicate email surfaces as a constraint error, mapped to a literal code).

## Rollout

1. Land Phases A–F behind `ARIES_TEAM_POLICIES_ENABLED=0`. Deploy is a no-op on prod (enum widened, no role assignable, no policy read).
2. On the prod box, confirm `/admin/members` and `/admin/roles` render the disabled state and the invariant suite is green.
3. Flip `ARIES_TEAM_POLICIES_ENABLED=1` for the single tenant, assign one non-admin teammate a `tenant_operator` role, enable "Only admins can publish," and verify in the dashboard that the operator is blocked and the admin is not.
4. Kill switch: set the flag back to `0` — instant revert to legacy `tenant_admin`-only authorization; assigned non-legacy roles become inert (treated as non-admin, which is the safe direction). No deploy needed.

## Out of Scope

- **Cross-tenant / multi-org membership** — one user still belongs to one organization (`users.organization_id`); `2026-03-15-tenant-context-milestone.md` owns that escalation. No membership join table here.
- **Per-resource ACLs / approval routing chains** ("posts over $X require CFO sign-off", multi-step approver chains) — this plan ships flat per-tenant policies, not workflow-engine routing.
- **Platform-operator / security-auditor UI** — those roles live in `permission-check.ts` for the RBAC grant map only; they are not surfaced in the tenant-facing member UI.
- **Email invitation delivery** — `createTenantUserProfile` already inserts an `invited_pending` row; wiring real invite emails (Resend) is separate.
- **Renaming `tenant_analyst`** — retained as a legacy live value; a future data migration to map analysts onto the new roles is out of scope.
- **Video/Reel/Story PUBLISHING surfaces** — owned by #520 / `2026-05-30-story-reel-video-publishing.md` and already shipped behind `ARIES_VIDEO_PUBLISH_ENABLED`; this plan only *adds an approval gate* on top of the `approve_video_render` checkpoint, it does not build any publish surface.
- **`MARKETING_STATUS_PUBLIC`** — never touched; never exposed in prod.
- **Honcho memory write semantics** — the memory policy only flips a curator outcome (`auto_approve`→`queue_for_review`); it does not change the curator's hard-reject list or the Honcho write path.

## Risks

1. **Union-widening literal-inequality bug (HIGH — has shipped 3× here).** Widening `TenantRole` without finding every `=== 'tenant_admin'` / `!== 'tenant_analyst'` silently mis-authorizes a new role. **Mitigation:** Phase A is a dedicated grep-sweep (10 known `tenant_admin` sites today) with a guard test; the `can()` helper is the only sanctioned authorization predicate; the grep commands are written into the phase.
2. **Two role enums drifting again.** `permission-check.ts` `Role` (7) vs `TenantRole` (now 7 tenant-facing). **Mitigation:** the tenant-facing roles become the single source in `lib/tenant-context.ts`; `permission-check.ts` imports/extends from it rather than re-declaring; a unit test asserts the two stay in sync.
3. **A policy accidentally weakens a hard gate (CRITICAL).** A bug in `evaluateTenantActionPolicy` returning `allow:true` could appear to bypass approval. **Mitigation:** policy enforcement is strictly *after* and *additive to* `validateAndConsumeApproval`; default-deny on ambiguity; `inv-07`/`inv-08`/`inv-09` run with the flag both ON and OFF and must stay green.
4. **Auto-approve + policy interaction.** If suppression is wrong, either the pipeline stalls forever (policy blocks, no human) or it auto-approves something a policy forbade. **Mitigation:** suppression is per-stage and explicit; default-deny means it stalls (safe) rather than over-approves (unsafe); the live operator can always approve manually in the review queue.
5. **DB pressure (guardrail #1).** Reading `tenant_approval_policies` per request adds a query. **Mitigation:** single-row PK lookup, only when the flag is ON; no `Promise.all` fan-out; benchmark the publish/approve endpoints (not just the helper) before enabling on prod, per guardrail #1 (`ARIES_WEB_CONCURRENCY * DB_POOL_MAX` budget).
6. **Treat-as-production.** This runs on the live VM. **Mitigation:** every change is flag-gated default OFF; the deploy is a verified no-op; enabling is a deliberate per-tenant operator action validated by rendered UI, not by DB/state signals.
