# One email, multiple workspaces — organization memberships

**Date:** 2026-07-03
**Status:** APPROVED at the /autoplan final gate 2026-07-03 (CEO + Design + Eng, dual voices each, 2-round spec review; owner revisions folded: Decision 13 paywall + taste/Honcho per-brand verification) — **approved for a future build session; do NOT build yet (Brendan's explicit instruction)**
**Author:** Hermes Agent (for Brendan)
**Origin:** 2026-07-03 support incident — inviting `socialmedia@sugarandleather.com` failed with "already belongs to another Aries account" because a May test sign-in had auto-created its own workspace. Three accounts (socialmedia@, troy@, steven@) were manually repointed into workspace 15 via prod `UPDATE users SET organization_id=15`. That workaround **moves** an account; it cannot let one email be in two workspaces, and it required manual SQL by an operator with DB access.

## Problem

Aries has no membership model. `users.organization_id` (single INTEGER FK, `scripts/init-db.js:30`) plus `users.role` (single TEXT, `:31`) **are** the tenancy model: one email = one user row = at most one workspace = one global role. Consequences:

1. **Inviting any email that ever signed in fails.** `inviteWorkspaceMember` returns `email_taken` when the email backs a user in a different org (`backend/tenant/workspace-invitations.ts:149-155`) — correct as an anti-hijack guard, but it makes every past Google sign-in (which auto-creates a personal workspace, `auth.ts:227-233` → `lib/auth-tenant-membership.ts:230-253`) permanently uninvitable.
2. **An agency/consultant model is impossible.** One person cannot be an editor in two client workspaces.
3. **Onboarding a second business silently abandons the first.** `resolveTenantForDraft` (`app/onboarding/resume/page.tsx:55-88`) re-uses or creates an org and repoints the single column — with role force-set to `tenant_admin`.
4. **Operator workarounds are manual prod SQL** (this week's fix), which is not a product.

## Goal

One `users` row per email, N workspace memberships, an explicit "active workspace" per session, and a workspace switcher — shipped **dark** (flag default OFF, byte-identical behavior until flipped; the one deliberate exception is Phase 0.5's narrow, consent-gated absorb-orphan invite relief, which ships unflagged as interim support relief), with the invite flow able to add an existing account to a second workspace **without** touching its credentials.

**Success bar (house rule):** rendered-UI verification on live prod — an existing account is invited to a second workspace, accepts, switches between workspaces in the shell, and the team list shows them in both; screenshots of each. API/DB state alone does not count.

## Non-goals (out of scope)

- Expanded role set / approval policies — that is roadmap #14 (`docs/plans/2026-06-01-team-roles-policies-ui.md`). This plan deliberately lands the **membership seam first** so #14's role widening has exactly one place to live (`organization_memberships.role`). See "Sequencing vs roadmap #14" below.
- Cross-workspace anything (shared assets, cross-posting, consolidated analytics).
- Multiple user rows per email — explicitly rejected (see Decision 1).
- Honcho peer re-salting (Decision 9 defers it as an accepted, documented property).
- Removing `users.organization_id` — it is repurposed, not dropped (Decision 2).

## Verified current state (all line-checked 2026-07-03)

**The pivot:** `users.email` UNIQUE (`scripts/init-db.js:27`), `users.organization_id` single FK (`:30`), `users.role` global TEXT (`:31`). No membership table exists.

**Resolution is DB-first, which dictates the whole design:**
- `lib/tenant-context.ts:74-77` — `loadTenantContextForUser`: `users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.id=$1 LIMIT 1`.
- `lib/tenant-context.ts:120-139` — `resolveTenantContextForSession` prefers the **DB row over session claims**; claims are only an outage fallback. A workspace switch stored only in the JWT would be silently overridden on the next request.
- `auth.ts:258-274` — the jwt callback **unconditionally re-hydrates** tenant claims from the DB row on every token access. So a DB-side pointer change propagates to the JWT automatically — no token surgery needed.
- ~43 route files consume `getTenantContext()` via `loadTenantContextOrResponse` and inherit correctness from the central resolver with zero edits.

**Auth/provisioning:**
- `auth.ts:152` sign-in select; `:227-233` `ensureTenantAccessForUser` auto-creates a personal org whenever `organization_id IS NULL`; `:235-248` hard-fails login on incomplete claims (`TenantClaimsIncomplete`).
- Second org-creation path: credentials signup server action `app/actions/auth.ts:28-109` (`registerUserAction`) inserts the org + user directly.
- `lib/auth-tenant-membership.ts:99-110` — `assignUserToOrganization` is a destructive `UPDATE users SET organization_id=$1` (+ global role overwrite at `:105`); `:170-228` — `findTenantClaimsByUserId/ByEmail`, both `LIMIT 1`.

**Invites (the blocker + the traps):**
- `backend/tenant/workspace-invitations.ts:149-158` — `email_taken` branch.
- `:84-88` — invite supersede keyed on `user_id` **alone** (under multi-membership, an org-B invite would kill a pending org-A invite).
- `:314-317` — accept does an **unconditional `UPDATE users SET password_hash`**; `:320-323` consumes ALL the user's invitations across orgs. If an existing *active* account could receive an invite, accepting it would **overwrite their password** — an account-takeover class bug that the current `email_taken` guard is masking.
- `backend/tenant/user-profiles.ts:209-213` — "remove member" is `DELETE FROM users` (would destroy the account + all other memberships).
- Pending status is the `INVITED_PENDING_PASSWORD` sentinel on the **global** user row, not per-workspace.

**Journey/onboarding:**
- `lib/auth-user-journey.ts:44-58,:133-163` — post-login destination from per-USER onboarding flags + the single org.
- `app/dashboard/layout.tsx:5-8` → `lib/onboarding-gate-server.ts:11-42` — there is **no middleware.ts**; the dashboard layout's `enforceOnboardingGate()` is the chokepoint, and it gates on **tenant-scoped** onboarding state. Switching into a not-yet-onboarded workspace would bounce the user out of `/dashboard` into onboarding (switch→gate→onboarding loop hazard).
- `app/onboarding/resume/page.tsx:42-53` reuses the current org when it "looks empty"; both branches (`:67-71,:79-83`) call `assignUserToOrganization(..., role:'tenant_admin')` — onboarding **self-escalates the caller to admin** of whatever org ends up current.

**Security gates:** ~10 admin gates key off the single global role (e.g. `app/api/tenant/profiles/route.ts:44`, `app/api/tenant/profiles/[userId]/route.ts:54,112`, `app/api/business/profile/route.ts:146`, `app/api/marketing/jobs/[jobId]/delete/handler.ts:55`). If a switcher changes `tenantId` but keeps the global role, an org-A admin becomes an org-B admin. **Role must move to the membership.**

**Confirmed SAFE as-is (keyed on tenant_id / internal secret, never resolve user→org):** all 8 sidecar workers; all `app/api/internal/*` routes; `approval-store` (no user column; actor strings are opaque); taste/preferences/variant stores (composite `(tenant_id,user_id)` keys — a user in two workspaces correctly gets two independent profiles); feedback store (frozen submitter snapshot); password reset (account-level, correct under one-row-per-email).

**System actors:** synthetic contexts hard-code `role:'tenant_admin'` with non-user actors (`app/api/internal/aries-research/callback/route.ts:84`, `backend/marketing/orchestrator.ts:887,:2257`, `backend/memory/write-events.ts:733`, `scripts/automations/honcho-performance-worker.ts:157`, `backend/tenant/organization-lifecycle.ts:15-20`). These have no membership row and must keep working.

**Also in the blast radius:** `backend/tenant/organization-lifecycle.ts` (org delete assumes pointer reassignment); `scripts/qa/mint-qa-session.ts:66-74` + `seed-qa-tenant.ts:51` (single-org join + pointer upsert); `backend/tenant/business-profile.ts:440-450` (`launch_approver_user_id` trusted in-tenant with no membership assertion); Honcho peer pseudonym `backend/memory/pseudonym.ts:30-39` (global-user HMAC → identical peer id across workspaces); pinned tests (`tests/auth/auth-tenant-membership.test.ts`, `tests/auth/tenant-context.test.ts`, `tests/tenant/user-profiles-isolation.test.ts`, `tests/tenant/workspace-invitations.test.ts`, `tests/prd-invariants/inv-04-tenant-derived-server-side.test.ts`).

## Decisions (proposed — for review)

1. **One `users` row per email + `organization_memberships` join table.** Membership = `(user_id, organization_id, role, status 'invited'|'active', invited_by_user_id, invited_at, accepted_at, last_active_at, created_at, updated_at)`, `UNIQUE(user_id, organization_id)`. `last_active_at` is written on **workspace switch and sign-in resolution only** — never per-request (DB-pressure guardrail #1) — and backfilled from `accepted_at`/`created_at`; it drives the most-recently-used default workspace. A companion `organization_membership_events` table (`id, organization_id, user_id, actor_user_id, event_type, metadata jsonb, created_at`) records membership **mutations** (invited/accepted/removed/role_changed) — workspace *switches* are structured log lines only, not rows (unbounded volume, no retention story). Both tables ship in the Phase 0 dark schema (init-db.js + migrations, repo convention). Credentials, password reset, and the Honcho peer model all stay account-level and unchanged. Duplicate-user-rows-per-email is rejected: `findTenantClaimsByEmail` is `LIMIT 1` (nondeterministic pick), password reset resolves by email, and email uniqueness is what makes reset/credentials sign-in sound.
2. **`users.organization_id` is repurposed as the ACTIVE-workspace pointer, not dropped.** This is the minimal-delta design that works *with* the DB-first resolver instead of against it: `loadTenantContextForUser` keeps reading it (now validated against a membership row), the jwt callback's unconditional re-hydrate propagates a switch automatically, and the ~43 `getTenantContext()` consumer routes need zero edits. Workspace switch = validate membership + `UPDATE users SET organization_id` + next request picks it up. (Rejected alternative: JWT-only active-workspace claim — the DB-first resolver at `lib/tenant-context.ts:131-138` would clobber it.)

   **2a. Concurrency hazard + mutation guard (CEO review F1 — REQUIRED before Phase 3 ships).** A global per-account pointer means a switch in tab A retargets every other open tab/device for the same account — and in Aries a retargeted **write** is a publish-to-the-wrong-workspace's-Instagram incident (irreversible, public). Mitigation, layered:
   - **Mutation guard (mandatory, Phase 3) — enforced INSIDE `getTenantContext()`, not `loadTenantContextOrResponse`.** Both eng voices independently found that ~12 mutating route files (team invite/role/delete, business profile, OAuth refresh, feedback) call `getTenantContext()` directly and never touch `loadTenantContextOrResponse` — a wrapper-level guard fails open on exactly the team-management surface this plan modifies. The check lives in `getTenantContext()` itself (header read via `next/headers`; skip when the header is absent): header present and ≠ resolved `tenantId` → throw a typed `WorkspaceMismatchError` that the HTTP layer maps to `409 workspace_mismatch` (never execute the mutation). The frontend API client pins the workspace id it booted under and sends it on every state-changing request. **Out-of-guard surfaces enumerated with rationale:** RSC/server actions that mutate on render (`app/onboarding/resume/page.tsx` — fixed separately by Decision 8; `registerUserAction` — pre-tenant by definition); `INTERNAL_API_SECRET` routes (no browser session). **A structural test (inv-01b pattern) walks every mutating `app/api` handler and asserts it reaches the workspace-mismatch check** — without it the guard silently rots. The header is opt-in by construction (old tabs/non-browser clients send none — acceptable rollout gap, documented); after a grace period the publish/schedule/approve routes hard-require it.
   - **Stale-tab read detector (Phase 3):** on window focus, the shell compares its booted workspace id against the session's current one; on mismatch it shows a blocking "Workspace changed to <X> — reload" banner. Reads can be one render stale; writes cannot (guard above).
   - **ADR — URL-scoped tenancy (Slack/Notion/Linear pattern) considered and deferred:** workspace-in-URL eliminates the hazard by construction but touches all ~43 routes plus every frontend link — an XL migration that fights the current session-derived `getTenantContext()` architecture. Verdict: pointer-now with mutation guard; URL-scoping is recorded as the future migration if multi-workspace becomes core daily-driver UX, acknowledging the migration cost grows the longer it waits. The switch endpoint is scaffolding, not architecture.
3. **Role lives on the membership row.** Claims/context queries join `organization_memberships` for `(active org, role)`; `users.role` becomes a legacy mirror of the active membership (kept in sync on switch for back-compat during rollout, deleted in a follow-up). Every admin gate keeps its `role !== 'tenant_admin'` check unchanged — the *value* it checks becomes membership-scoped via the central resolver. This is also the seam roadmap #14 widens later.
4. **Invite flow becomes membership-aware; accept NEVER touches an existing account's credentials.** The `email_taken` branch becomes: existing user in another org → create `status='invited'` membership + invitation row (keep refusing only when already a member of *this* org). Accept splits by account state: brand-new user (pending-password sentinel) → set password + activate membership (today's flow); **existing active account → activate membership only — no password write, no cross-org invitation consume**. Supersede (`:84-88`) and consume (`:320-323`) re-scope to `(user_id, organization_id)`. The invite email for an existing account says "you've been added — sign in with your existing credentials/Google".
5. **Remove-member deletes the membership row, never the user.** `deleteTenantUserProfile`'s `DELETE FROM users` becomes `DELETE FROM organization_memberships WHERE user_id AND organization_id`; if the removed workspace was the user's active pointer, repoint to another membership (or NULL + picker). The users row survives.
6. **Flag-gated, default OFF: `ARIES_MULTI_WORKSPACE_ENABLED`** (env-var pattern: `1|true|yes|on`, module `backend/tenant/multi-workspace-env.ts`, wired in BOTH `.env` and the compose `environment:` block per the two-place rule). When OFF: invite keeps returning `email_taken`, no switcher renders, resolver behavior byte-identical. The **schema + backfill ship dark** (additive; one `active` membership row per user derived from `users.organization_id`/`users.role`) and are safe with the flag OFF — mirrors the draft-expiry/GC rollout pattern.
7. **Sign-in provisioning gains a membership guard — and stops minting junk orgs (flag ON).** `ensureTenantAccessForUser` behavior splits by flag. Flag OFF: today's auto-provision, byte-identical. Flag ON: NULL pointer + N≥1 memberships → repoint to the deterministic default (most-recently-used via `last_active_at`, else oldest); **zero memberships → land on an explicit "Create your workspace / Ask your admin for an invite" chooser instead of silently minting a personal org.** Both review voices independently flagged eager org-provisioning as the root cause of the orphan-workspace incident class (every teammate who Google-signs-in before being invited mints a junk org they're admin of); the chooser kills the class at the source. `TenantClaimsIncomplete` hard-fail is reserved for genuinely corrupt states.
8. **Onboarding semantics:** onboarding remains per-workspace via the existing tenant-scoped gate (`evaluateOnboardingGate({tenantId})` — already correct). Fixes required: (a) `resolveTenantForDraft` must stop reusing/repointing orgs when the flag is ON — "onboard a second business" = create org + create admin membership + set active; (b) the self-escalation-to-admin (`role:'tenant_admin'` on both branches) is guarded — only apply to orgs the user created, never an existing org they merely belong to; (c) switching into a not-yet-onboarded workspace lands on a scoped "finish setting up this workspace" state rather than a redirect loop (the gate already redirects; verify the loop terminates and the switcher remains reachable).
9. **Honcho peer pseudonym stays as-is, documented.** Workspaces (`aries-tenant-<HMAC>`) already isolate tenants; the same person carrying one peer id across their own workspaces is arguably correct (it *is* the same human), and re-salting by tenant would orphan existing peer history. Recorded as an explicit accepted property; revisit only if a true data-isolation requirement appears.
10. **System actors bypass membership checks by construction.** Membership validation lives in the session-derived resolution path only; `INTERNAL_API_SECRET`-authed routes and synthetic contexts (`userId:'system'`, worker contexts) never hit it. No escape-hatch flag needed — just keep the check out of the synthetic-context constructors.
11. **Org deletion repairs pointers.** `organization-lifecycle` cascade: delete memberships, then for any user whose active pointer targeted the deleted org, repoint to their next membership or NULL (picker on next login). Prevents the claims-incomplete login hard-fail.
12. **Sequencing vs roadmap #14 (team roles & policies):** this plan lands first and is a prerequisite refactor for it — #14's "one role enum, expanded" and its role-assignment UI operate on `organization_memberships.role` instead of `users.role`, and its Phase-A "inventory the `=== 'tenant_admin'` inequality sites" pass is shared groundwork (the sites don't change here, but the inventory de-risks both plans).

13. **Multi-workspace is a PAID entitlement (owner revision, 2026-07-03 gate).** Aries is free for one workspace per account; attaching a **second business to the same account** requires the paid plan. Mechanics:
   - **Schema (Phase 0, dark):** `users.plan TEXT NOT NULL DEFAULT 'free'` (values `free` | `pro` for v1; no CHECK constraint, matching `users.role` convention) + `plan_granted_at`/`plan_granted_by` audit columns. Account-level, not workspace-level — the entitlement follows Brendan's framing ("more than one business for *their account*").
   - **One enforcement helper, server-side:** `assertMultiWorkspaceEntitlement(queryable, userId)` in `backend/tenant/entitlements.ts` — passes when the user's count of **`status='active'` memberships is 0 or they already hold `plan='pro'`**; called at every choke point that would attach a second active membership: (a) the consent-accept activation transaction (Phase 2), (b) second-workspace creation (Phase 4 onboarding path + any future create entry point), (c) NOT the absorb-orphan flow (absorb *replaces* the old workspace — the account still ends at one workspace; interim relief stays free), (d) NOT plain team invites into a user's only workspace (the original incident case stays free — a teammate's first membership never pays), (e) NOT switching among already-attached workspaces. The check runs INSIDE the activation transaction (same TOCTOU discipline as the rest of the accept path), counting rows `FOR UPDATE` so two concurrent accepts can't both slip under the free limit.
   - **Denial semantics:** the API returns `402 payment_required` with a frontend-safe `{ code: 'multi_workspace_requires_pro' }`; **invited memberships are still created and persist** — the invite is never destroyed by the paywall; the invitee sees the upgrade screen and can accept later once upgraded. `resendWorkspaceInvitation` unaffected.
   - **Granting (v1):** manual CLI `scripts/billing/set-user-plan.ts --email <email> --plan pro` (validated, audited via the granted_at/by columns + a structured log line). **Payment-processor integration (Stripe/checkout/subscription lifecycle) is explicitly OUT of this plan's scope** — the entitlement seam is designed so a payments PR later only replaces the CLI as the writer of `users.plan`, touching zero enforcement code.
   - **Pricing-policy note (recorded, relaxable without schema change):** v1 counts ALL active memberships toward the limit — an invited consultant joining a second client's workspace hits the paywall exactly like a two-business owner (the owner's literal framing). If the business later prefers "owned workspaces pay, invited memberships free," the change is one predicate in the helper (count memberships where the user is the org creator/admin), no migration.
   - **Grandfathering:** none needed — the single-org model means no account has two memberships today; the backfill creates exactly one per user.
   - **Downgrade semantics:** enforcement is at ATTACH time only. A pro account that reverts to free keeps its existing active memberships (no retroactive removal — never strand someone out of a workspace they're working in) but cannot attach further ones. If the business later wants downgrade-forces-choice, that's a policy layer on the same helper.
   - **Flag interaction:** no separate paywall flag; enforcement is part of the flag-ON path (flag OFF ⇒ multi-membership impossible ⇒ nothing to gate). The helper is also consulted by the zero-membership chooser's "Create a workspace" only when the account already has ≥1 active membership (i.e. reached via the Phase-4 "new workspace" entry, not first-run onboarding).

## Phases

**Phase 0.5 — narrow interim relief: absorb-orphan-workspace on invite (shippable ahead of the flag; lands AFTER Phase 0's schema so the audit table exists).**
Productizes this week's manual SQL with guardrails: when an admin invites an email whose existing account's workspace is an **orphan** (sole member, no completed onboarding, zero posts/connected accounts/creative assets), the invite flow — instead of `email_taken` — sends the normal invite email, and the accept page shows an absorb-consent variant ("fold your unused workspace into <X>?"). **The repoint executes only on the INVITEE's accept click — never on admin action alone** (the same consent principle OQ1 ratified; an orphan workspace is still someone's account and login destination). The absorbed account lands with the role the admin chose on the invite (default `tenant_analyst`), never its old `tenant_admin`. Writes an `absorbed` event row (event-type enum: invited/accepted/removed/role_changed/**absorbed**). Strictly bounded: any activity in the source workspace → normal (Phase 2) membership path only. This removes the manual-prod-SQL support class in days without waiting for the membership program, and both review voices demanded interim relief. (CEO review F2; consent hole caught in spec-review iteration 2.)

**Phase 0 — dark schema + backfill (no behavior change, flag irrelevant).**
`organization_memberships` + `organization_membership_events` tables in `scripts/init-db.js` + `migrations/` (both, per convention); **`users.plan` entitlement columns (Decision 13)**; lowercase-unique email index after dedupe audit (eng finding 7); idempotent backfill INSERT…SELECT from `users` (one row per user with an org, `status` derived from the pending sentinel — eng finding 2); partial indexes for the hot lookups (`user_id`, `(organization_id, status)`). Dual-write in legacy provisioning paths starts here (eng finding 1). Deploy; verify prod row counts match users-with-orgs. QA seed/mint scripts updated to also upsert a membership (they must work in both worlds).

**Phase 1 — membership-aware resolution (flag ON path).**
`lib/auth-tenant-membership.ts` claims queries join memberships (role from membership; pointer validated against a membership row — a pointer to a non-membership org resolves like NULL); `ensureTenantAccessForUser` guard per Decision 7; `lib/tenant-context.ts` `loadTenantContextForUser` same join. Flag OFF → current queries verbatim (two code paths, golden-tested byte-identical OFF). Session gains `workspaceCount` (or a small memberships list) so the shell can decide whether to render a switcher without an extra fetch (`types/next-auth.d.ts` augment).

**Phase 2 — invite/accept/remove membership semantics (flag ON path).**
`workspace-invitations.ts` per Decision 4 (including the existing-active-account accept path that never writes `password_hash`, the lock-based accept transaction, and the **entitlement check inside the activation txn — Decision 13**); `user-profiles.ts` list joins memberships, create = find-or-create user + membership (`ON CONFLICT (email)`), update-role targets membership + active-mirror sync, delete = membership only (Decision 5) with the serialized last-admin guard; membership event rows; resend gate moves to `membership.status`; settings-screen copy: `email_taken` message only remains for flag-OFF; new "added existing account" success state; upgrade-required screen variant.

**Phase 3 — switcher UI + switch endpoint.**
`POST /api/tenant/workspace/switch` (session-authed; validates target membership `status='active'`; `UPDATE users SET organization_id` + `users.role` mirror in one transaction; writes `last_active_at`; structured switch log line). Switcher in the app shell (`components/redesign/layout/app-shell.tsx` — renders only when `workspaceCount > 1` and flag ON; **top-bar placement is the default pending the final-gate ruling on OQ3**); active-workspace name displayed. Ships WITH the mutation guard + stale-tab detector (Decision 2a — required, not optional). Onboarding-gate interaction verified per Decision 8c.

**Phase 4 — second-workspace creation + lifecycle repair.**
Onboarding resume fixes (Decision 8a/8b); org-deletion pointer repair (Decision 11); `launch_approver_user_id` writers assert approver membership (`business-profile.ts:440-450`); "create new workspace" entry point lives in the **account menu / settings — NOT the switcher** (the switcher renders only at `workspaceCount > 1`, so a switcher-hosted create action would be unreachable for exactly the single-workspace users who need it; caught by the design review). Reuses the onboarding flow, **gated by the Decision-13 entitlement check** (second workspace = pro), and ships the `scripts/billing/set-user-plan.ts` grant CLI.

**Phase 5 — flag retirement (numbered, not prose).**
Criterion: **2+ weeks of incident-free prod after rendered-UI verification, executed within 2 releases of that verification.** Then: remove the flag-OFF resolver path, drop the `users.role` mirror (single source of truth = membership row), and delete the legacy auto-provision branch. A grep/lint gate rejects new `users.role` reads outside the membership module from Phase 1 onward. This repo has a documented flag-graduation gap and this flag forks the **auth resolution path** — the worst place to keep two long-lived code paths; Phase 5 is scope, not a wish. (CEO review F5.)

Each phase is a separate PR with its own review; Phases 1–4 are inert with the flag OFF.

**Honest justification framing (CEO review F4, both voices):** this program is a **seam-first refactor** justified by (1) the two masked P1 security classes it removes (accept-path password overwrite; global-role cross-org escalation), (2) the incident class it kills (orphan orgs + uninvitable emails), and (3) being the prerequisite seam for roadmap #14 role/policy work on the public-readiness path. The agency/multi-client model is enabled as a byproduct, not evidenced demand — no agency prospect is named, and one paying tenant exists today. Phase 3/4 UI polish is scoped accordingly (functional switcher, not an agency product). **Pre-GA open product decisions:** ~~billing/entitlement semantics~~ **DECIDED by the owner at the 2026-07-03 gate** — multi-workspace is the paid tier (Decision 13); payment-processor integration remains a follow-up. Still open, deliberately NOT designed here: per-seat pricing within a workspace; cross-workspace agency views (queue/calendar across clients) — the active-workspace model is the substrate, not the answer, for those. "Create new workspace" placement was resolved by the design review (account menu, not switcher).

## Test strategy

- **Golden byte-identical OFF:** claims/context resolution and invite behavior with flag OFF must match today exactly (fixture-level golden tests, same pattern as the taste-brief golden).
- **New unit coverage (flag ON):** second-membership invite; accept-as-existing-account (asserts `password_hash` untouched — the account-takeover regression test); supersede/consume scoping across two orgs; remove-member preserves the user + other membership; switch endpoint rejects non-member target (security); pointer-to-non-membership resolves as NULL; zero-membership auto-provision vs N-membership repoint; role isolation (admin in A, viewer in B — B's admin gates reject).
- **Update pinned tests** listed in the blast radius; keep `inv-04-tenant-derived-server-side` green in both flag states.
- **Requires-infra split:** live-Postgres membership backfill test goes in `tests/REQUIRES_INFRA.md` per the existing convention.
- `npm run verify` + `npm run test:concurrent` gates; deploy-manifest parity untouched (no new sidecar).

## Risks

1. **Account takeover via accept (P1, designed away in Decision 4)** — the unconditional password write at `workspace-invitations.ts:314-317` must never be reachable for an active account. The regression test above is mandatory in the same PR that opens the invite path.
2. **Privilege escalation via stale global role (P1, designed away in Decision 3)** — any code path that reads `users.role` directly after Phase 1 is a potential cross-org escalation; add a lint/grep gate for new `users.role` reads outside the membership module.
3. **Switch→onboarding-gate loop (P2)** — Decision 8c; needs explicit rendered-UI verification.
4. **Backfill drift (P2)** — users created between backfill and flag-flip; sign-in path (Phase 1) creates the membership row on demand (self-healing), so drift is transient.
5. **Test-suite rot (P2)** — five pinned test files; budgeted in each phase, not deferred to the end.
6. **The May-2026 manual repoints (users 2/16/17)** are already consistent with the backfill (they'll get `active` memberships in workspace 15); their abandoned empty orgs (8/58/59) get no member and are invisible — harmless.

## Open questions for review

1. Should "invite an existing account" require the invitee to explicitly ACCEPT (email link → "join workspace X?" consent screen) rather than auto-activating on admin action? **Security review upgraded this from taste to strongly-recommended:** without consent-accept, an admin can attach a stranger's account to their workspace, creating mutual visibility (the invitee could switch into the admin's workspace and vice-versa). Require accept.
2. ~~Deterministic default workspace~~ **RESOLVED (CEO review, E1 accepted):** add `last_active_at` to the membership row; default = most recently used, fall back to oldest. Write it on **switch and login only** — never per-request (write amplification).
3. Does the switcher belong in the top bar or the settings screen for v1? (Shell top-bar is the durable answer; settings-only is a smaller Phase 3.) — taste decision, surfaced at the final gate.

---

# CEO Review additions (2026-07-03, /autoplan Phase 1 — SELECTIVE EXPANSION)

## Accepted scope expansions
- **E1 `last_active_at`** on membership; most-recently-used default workspace (resolves open question 2).
- **E3 Membership audit trail** — event rows for membership **mutations** (invite/accept/remove/role-change/absorb) with actor, target user, org, timestamp; workspace **switches are structured log lines only, not rows** (see Decision 1 for the authoritative spec). Answers "who added X?" three weeks later; required by the observability review. Event-row writes land in **Phase 2** (mutation paths) and Phase 0.5 (absorb); switch logging + `last_active_at` writes land in **Phase 3**.
- **E4 Last-admin guard** — remove-member and role-downgrade paths refuse to strip a workspace's only `tenant_admin` (else a workspace becomes unadministrable). **Transactional/conditional form** (TOCTOU-immune): `UPDATE/DELETE … WHERE EXISTS (SELECT 1 FROM organization_memberships om WHERE om.organization_id=$org AND om.role='tenant_admin' AND om.status='active' AND om.user_id<>$target)`. Interplay: org deletion (Decision 11) bypasses the guard; self-service leave (E6, if accepted) honors it. Enforcement lands in **Phase 2** (member CRUD paths).

## Hardening findings folded into the design (all auto-decided, P1 completeness)
1. **Accept TOCTOU (account-takeover class):** the accept path must re-check the account's pending-vs-active state INSIDE the accept transaction, not before it — an account that transitions pending→active between invite issuance and accept (Google sign-in, or a sibling org's invite) must not reach the password write. The Decision-4 split branches on state read under the same transaction as the `UPDATE users SET password_hash`.
2. **Concurrent duplicate invite:** two admins inviting the same email simultaneously hit `UNIQUE(user_id, organization_id)` — handle with `ON CONFLICT` → idempotent re-invite (fresh token supersedes), never a 500.
3. **Switch atomicity:** `POST /api/tenant/workspace/switch` updates the pointer AND the legacy `users.role` mirror in one transaction (else a request in the skew window carries org-B tenantId with org-A role).
4. **Single-query resolution:** pointer validation + role fetch is ONE indexed join in the central resolver (`users` ⋈ `organization_memberships` ⋈ `organizations`), not sequential queries — hot path on every authenticated request.
5. **Claims-query consolidation (DRY):** `findTenantClaimsByUserId` / `findTenantClaimsByEmail` / `loadTenantContextForUser` today triplicate the same join; Phase 1 consolidates them onto one membership-claims helper so the membership join exists in exactly one place.
6. **Org deleted before accept:** accept against a deleted org fails the membership FK — rescue to a user-visible "this workspace no longer exists" state, not a 500.
7. **Removed-while-active convergence:** a member removed from their active workspace converges on the next request (DB-first resolver + jwt re-hydrate); document as intended behavior, verify with a test.
8. **Explicit Phase-0 indexes:** PK `(user_id, organization_id)`, plus `organization_memberships(user_id)` and `(organization_id, status)`.
9. **Flag graduation criteria:** see **Phase 5** (the authoritative statement): 2+ weeks of incident-free prod after rendered-UI verification, executed within 2 releases — removes the OFF code path and drops the `users.role` mirror (this repo has a documented flag-graduation process gap — do not leave both paths alive indefinitely).
10. **QA sandbox:** the `aries-qa-sandbox` bot gets exactly one membership; `assertQaScoped` and the mint script move to the membership join so the bot can never switch into a real tenant.

## Error & Rescue Registry

```
METHOD/CODEPATH                  | WHAT CAN GO WRONG                          | HANDLING                                    | USER SEES
---------------------------------|--------------------------------------------|---------------------------------------------|------------------
resolveActiveMembership          | pointer → org with no membership row       | treat as NULL → deterministic repoint/picker | picker (or silent repoint)
                                 | zero memberships (flag OFF)                | auto-provision personal org (today's path)   | onboarding
                                 | zero memberships (flag ON)                 | NO org created → explicit chooser (Dec. 7)   | create-or-get-invited chooser
                                 | DB error                                   | existing TenantContextError path             | 500 / claims fallback
inviteWorkspaceMember (mod)      | invitee already member of THIS org         | already_member (existing)                    | "already a member"
                                 | concurrent duplicate invite                | ON CONFLICT → idempotent re-invite           | success
                                 | invitee is existing account elsewhere      | membership invite created (new happy path)   | "invited"
acceptWorkspaceInvitation (mod)  | token invalid/expired/used                 | existing statuses                            | existing pages
                                 | account went active since invite (TOCTOU)  | re-check state in accept txn; no pw write    | consent variant
                                 | org deleted before accept                  | FK failure → rescued                         | "workspace no longer exists"
switchWorkspace (NEW)            | target not a membership                    | 403, structured log                          | "not a member"
                                 | target membership still 'invited'          | 403                                          | "accept your invite first"
                                 | pointer/role-mirror skew                   | single transaction                           | n/a
deleteTenantUserProfile (mod)    | removing last admin                        | blocked (E4 guard)                           | "assign another admin first"
                                 | removed user's pointer targets this org    | repoint to next membership / NULL            | picker on next visit
organization delete (Phase 4)    | members' pointers target deleted org       | cascade memberships + repoint in txn         | picker
membership backfill (Phase 0)    | partial failure / re-run                   | idempotent INSERT…SELECT ON CONFLICT NOTHING | n/a
```

## Failure Modes Registry

```
CODEPATH                  | FAILURE MODE                      | RESCUED? | TEST?         | USER SEES?              | LOGGED?
--------------------------|-----------------------------------|----------|---------------|-------------------------|--------
accept (existing account) | password overwrite (TOCTOU)       | Y (txn)  | REQUIRED      | consent page            | Y
invite                    | duplicate membership race         | Y        | REQUIRED      | success (idempotent)    | Y
switch                    | non-member target                 | Y (403)  | REQUIRED      | error toast             | Y (audit)
switch                    | role/pointer skew                 | Y (txn)  | REQUIRED      | nothing                 | Y
remove member             | last-admin removal                | Y (guard)| REQUIRED      | blocking message        | Y (audit)
remove member             | account deletion (old behavior)   | Y (design)| REQUIRED     | member gone, acct kept  | Y (audit)
resolver                  | pointer → non-membership org      | Y        | REQUIRED      | picker/repoint          | Y
org delete                | stranded active pointers          | Y        | REQUIRED      | picker                  | Y
backfill                  | partial run                       | Y        | requires-infra| n/a                     | Y
```
No CRITICAL GAP rows remain — every failure mode above is rescued, tested, user-visible or intentionally silent, and logged.

## Additional test specs (fold into Test strategy)
- Concurrent accept-vs-signin TOCTOU race (asserts no password write on active account).
- Concurrent duplicate invite → single membership row, newest token wins.
- Switch endpoint: non-member org id → 403; 'invited' membership → 403; valid → pointer+mirror updated atomically.
- Last-admin guard on remove and downgrade.
- Org-deleted-before-accept → user-visible failure.
- Removed-while-active → next request resolves the new workspace.
- Backfill idempotency (requires-infra split).
- Role isolation 2am test: admin-in-A + viewer-in-B; B's admin-gated routes reject.
- **Hybrid credential-state matrix (CEO review F6):** pending-password membership in org A while ACTIVE member of org B (and every permutation) — proves the password write is unreachable for any account with ≥1 active credential, not merely per-invitation; guards the invariant that invitation supersede/consume re-scoping to `(user_id, organization_id)` does not resurrect the stale-sibling-token password reset.
- Mutation guard: mutating request carrying a mismatched `x-aries-workspace-id` → 409, mutation not executed; publish/schedule/approve routes covered explicitly.
- **Entitlement (Decision 13):** free account accepting a SECOND membership → 402, membership stays `invited`, accept succeeds after `set-user-plan --plan pro`; concurrent double-accept under the free limit → exactly one 402 (FOR UPDATE count); absorb flow NEVER hits the paywall (replacement, not addition); first-membership teammate invite NEVER hits it; pro user unaffected at every choke point.
- Zero-membership chooser (flag ON): Google sign-in with no memberships lands on the chooser, no org row is created until explicit intent.
- Absorb-orphan flow (Phase 0.5): eligible only when source workspace is sole-member + zero activity; any content → falls back to membership invite path.

## User flow (Section 11)

```
 admin: Settings → Invite (email exists elsewhere)
   └─▶ membership(status=invited) + email
        └─▶ invitee: link → CONSENT page ("Join <Workspace>?")
              ├─ new account: set password → membership active
              └─ existing account: [Accept] (no password step) → membership active
                    └─▶ sign-in (Google/credentials)
                          └─▶ SHELL: workspace name + switcher (≥2 memberships)
                                ├─ switch → pointer txn → next request in new workspace
                                └─ workspace not onboarded → scoped "finish setup" state
```
Switcher states: hidden (1 membership) / list (N) / error → falls back to current workspace. Picker page: 0 memberships → **chooser when flag ON (no silent provision; Decision 7) / auto-provision when flag OFF**; 1 → auto-enter; N → list. Keyboard navigation + focus trap on the switcher menu are in Phase 3 scope.

## NOT in scope (CEO phase consolidation)
- Roadmap #14 role expansion/policies (lands on this seam later) — sequencing decision, not omission.
- Cross-workspace features (shared assets, consolidated analytics, cross-posting).
- Per-workspace notification preferences → TODOS.md.
- Org-deletion self-service UI (lifecycle repair ships; UI does not) → TODOS.md.
- Honcho peer re-salting (accepted, documented property — Decision 9).
- Duplicate-user-rows model (rejected — breaks email-keyed auth).
- JWT-only active-workspace claim (rejected — DB-first resolver clobbers it).

## What already exists (reused, not rebuilt)
- Invitation machinery: token mint/hash, supersede, accept page, resend (`workspace-invitations.ts`) — reused with membership scoping.
- Central resolver seam (`getTenantContext` + `loadTenantContextOrResponse`) — ~43 routes inherit correctness, zero edits.
- JWT re-hydrate-from-DB (`auth.ts:258-274`) — the propagation mechanism for switches; no token surgery.
- Tenant-scoped onboarding gate (`evaluateOnboardingGate({tenantId})`) — already per-workspace.
- Composite-keyed taste/preference stores — already correct under multi-membership.
- Team management UI panel (settings-screen) — extended, not rebuilt.

## Dream state delta
This plan lands the substrate of the 12-month ideal (agency model): identity/membership separation, per-membership roles, active-workspace switching. Remaining distance to ideal after this ships: role richness + approval policies (#14), cross-workspace views, and workspace-management UI (rename/delete/transfer) — all of which now have a stable seam to build on.

# Design Review additions (2026-07-03, /autoplan Phase 2 — 7 passes, APP UI rules)

**Component vocabulary (Pass 5 — reuse, don't invent):** all new surfaces use the existing aries-v1/redesign primitives — `StatusChip` for role and invited/active badges, `ShellPanel` for the consent and chooser pages, `EmptyStatePanel`/`LoadingStateGrid` where applicable; the switcher matches the shell's existing menu pattern. No new visual vocabulary, utility copy only (orientation/status/action). No repo DESIGN.md exists — universal app-UI rules applied; a `/design-consultation` pass is a later nice-to-have, not blocking.

**Information architecture (Pass 1, corrected against the real shell):** the shell is a **collapsed hover-expanding left rail** with account controls at the rail bottom and a separate mobile drawer (`components/redesign/layout/app-shell-client.tsx:547,594,687,788`) — there is no top bar. Workspace identity gets first-class placement: **desktop = rail top, directly under the Aries mark** (visible even collapsed — truncated name/avatar chip, full name on expand); **mobile = the header, visible before opening the drawer**. The account menu stays account-only — workspace identity is the safety boundary, not account metadata. Switcher menu order: current workspace (check + role badge) → other memberships in MRU order (name + role badge; **invited memberships shown disabled with an Accept affordance only if E2 is accepted**) → divider → workspace management entry. **"Create workspace" does NOT appear in the v1 switcher** (proliferation risk flagged by both CEO voices; creation stays in the deliberate onboarding path). Long workspace names truncate with title-tooltips at every surface. Consent page hierarchy: workspace name + who invited you → role you'll have → accept CTA; decline is a quiet secondary action.

**Switching behavior (Codex design voice, accepted):** the target row disables + shows inline progress while the switch is pending; the menu closes only after the confirmed navigation; failure preserves the current workspace with an inline error (never a half-switched state). Additional states specified: slow switch (progress persists, no double-fire), membership removed while menu open (row errors on click → refresh list), active workspace deleted (resolver repoints; shell shows the interlock), stale membership list (refetch on open).

**Stale-workspace interlock (upgrades the Pass-3 dialog + Decision 2a banner):** one shell-level **fixed blocking overlay** (`role="alertdialog"`, no dismiss, sits above route content — never an in-content banner that can scroll away), primary action **Reload into <Y>**, secondary **Switch back to <X>**. ALL `409 workspace_mismatch` responses route into this same interlock (never a toast); destructive controls freeze behind it and local draft text is preserved for copy-out. This is the UX half of the mutation guard.

**Interaction state table (Pass 2):**

```
FEATURE            | LOADING                  | EMPTY                | ERROR                        | SUCCESS                    | PARTIAL
-------------------|--------------------------|----------------------|------------------------------|----------------------------|------------------
Switcher menu      | row spinner on target    | hidden (<2 members.) | toast, stay in current ws    | shell re-renders new ws    | pending-invite row (chip)
Consent page       | skeleton panel           | —                    | expired/invalid/deleted-org  | "You're in <ws>" → enter   | already-accepted → enter
Zero-mem chooser   | —                        | is the empty state   | creation fails → inline err  | onboarding starts          | —
Team list          | existing LoadingStateGrid| existing empty panel | existing error copy          | member row + StatusChip    | invited (chip) / expired invite (chip + resend)
Stale-tab guard    | —                        | —                    | 409 → blocking dialog        | reload lands in session ws | —
```

**Journey decisions (Pass 3 + dual design voices, auto-decided):**
- **Post-accept landing:** accepting an invite sets the active workspace to the accepted one and **hard-navigates to that workspace's `/dashboard`** ("you're in" moment; the rail showing the new name is the success state) — never leaves the user in their old default.
- **Switch transition:** pending spinner on the target row → on 200, **hard-navigate to the new workspace's `/dashboard`** — never attempt to preserve the current route across a switch in v1 (the route points at cross-tenant data). Switch failure = inline error inside the switcher flyout (no toast system exists in this app — do not invent one for this).
- **Admin invite copy** for existing accounts: success = "Added — pending their acceptance"; the form helper ("they'll get an email with a link to set a password") and the resend path get existing-account variants too.
- **Consent-page auth + states:** for an existing account, **sign-in is required before the Accept button is actionable** (token possession alone is not consent — the link can be forwarded). Four states specified: not-signed-in (sign-in prompt), signed-in-as-a-different-account ("this invitation is for <email> — switch accounts"), already-accepted (idempotent: "You're already a member — open <Workspace>"), and post-accept (rule above). Disclosure content, in order: workspace name + who invited you (`invited_by_user_id`), the role in plain words (reuse `workspaceRoleLabel`), which account is accepting ("as <email>"), one sentence on what joining means ("Admins of <X> will see your name and email"). **Decline is a real, visible action**, not just closing the tab.
- **Zero-membership chooser is invite-aware:** it first checks for pending `status='invited'` memberships for the signed-in email and, when found, "**You've been invited to <X> — Accept invite**" is the primary action (independent of the E2 taste item — without this, an already-invited user is told to ask for an invite they already have). No pending invite: "Create a workspace" primary + "Waiting for an invite?" explanatory secondary (the admin needs your email address — not a mystery button).
- **Mutation-guard 409 UX = the stale-workspace interlock** (single shared client handler for every mutating surface; publish drawers, review approve, and schedule all route through it): "This tab was working in <X>, but your account is now in <Y>. Your action was NOT performed." Actions: **Reload into <Y>** / **Switch back to <X>**. The interlock never auto-reloads or navigates on its own — user-initiated only, so unsaved text (a half-edited caption) survives behind the dialog and is recoverable via Switch back. Trigger: window focus **and** the first API response whose workspace id ≠ the tab's pinned id (covers polled screens, which would otherwise repaint with new-workspace data under old-workspace chrome).
- **At-rest workspace identity (required, not hover-only):** collapsed rail shows a workspace initial/color chip under the Aries mark; the mobile header shows the workspace name (replacing the static "Aries AI / Marketing OS" wordmark). "Which workspace am I about to publish to?" must be answerable at a glance.
- **Backfill naming audit:** auto-provisioned personal orgs carry machine-minted names (e.g. "EatRight", "Steven Wong") that become user-visible in switcher lists after backfill — audit/repair display names before the switcher ships.
- **Upgrade-required screen (Decision 13):** a variant of the consent page shown when the accept would attach a second workspace to a free account — workspace context stays visible (name, inviter, role) with the paywall framed as the account's state, not an error: "Your account is on the free plan, which includes one workspace. Joining <X> as a second workspace needs Aries Pro." Primary CTA: upgrade path (v1: "Contact <owner>" / instructions, until payments ship); secondary: "Not now" (the invitation is kept — say so explicitly: "Your invitation stays valid"). Same treatment on the Phase-4 create-second-workspace path. Utility copy, ShellPanel layout, no dark-pattern urgency.

**Responsive & accessibility (Pass 6):** switcher = menu/listbox pattern (roving focus, Esc closes AND returns focus to the trigger, `aria-expanded`/`aria-activedescendant`, post-switch announcement via `aria-live="polite"` "Now in <workspace>"), **44px minimum touch targets — do not copy the ~30px settings-screen action buttons** (`frontend/aries-v1/settings-screen.tsx:405`), role-badge contrast ≥ 4.5:1 on the dark theme; responsive placement per Pass 1 (collapsed rail / expanded rail / mobile header / mobile drawer all specified); consent/chooser pages single-column at 375px with full-width CTAs; chooser = two explicit actions with loading + error states and copy that explains no workspace exists without blaming the user.

**Rendered-QA screenshot checklist (success-bar detail):** desktop collapsed rail, desktop expanded rail + open switcher, mobile header + drawer, stale-workspace interlock, switch-pending state, switch-failure state, zero-membership chooser, consent page (new-account and existing-account variants).

**AI-slop guards (Pass 4):** consent/chooser pages must not become generic centered cards — they use the shell's panel layout with left-aligned content; no icon-in-circle decoration; no purple-gradient backgrounds beyond the existing brand accent.

**Design decisions resolved at the final gate (2026-07-03):** **E2 ACCEPTED** — pending-invite rows render in the switcher (disabled row + Accept chip; Phase 3). **E6 ACCEPTED** — self-service "Leave workspace" in settings, reusing remove-member semantics + the last-admin guard (Phase 3). **OQ3 (switcher placement) auto-resolved by cross-model consensus:** both design voices independently found the "top bar" option references a UI region that does not exist (the shell is a collapsed left rail) and that settings-only would bury the app's most identity-critical control — placement is **rail-top under the Aries mark** (desktop) + mobile header, per the Pass-1 spec above. Recorded at the final gate for visibility, not re-decision.

# Eng Review additions (2026-07-03, /autoplan Phase 3)

## Hardening findings folded into the design (dual eng voices; all auto-decided P1)

1. **Continuous dark-period drift (BOTH voices, HIGH):** between Phase 0 and flag-flip, every flag-OFF signup/invite/onboarding write creates users with pointers but **no membership row**, and users with live 30-day JWTs never re-enter the sign-in self-heal. Fix (both, belt-and-braces): (a) **dual-write** an `active` membership row in every legacy provisioning path from Phase 0 onward (Google sign-in provision, credentials signup `app/actions/auth.ts`, invite `createTenantUserProfile`, onboarding `resolveTenantForDraft`); (b) **resolver-level self-heal** — a pointer to an existing org with no membership row inserts one `active` membership derived from the pointer (trusting the pointer once = exactly today's trust model); (c) re-run the idempotent backfill immediately before flip.
2. **Backfill maps the pending sentinel (Claude S1, HIGH):** backfill derives `membership.status` from the account state — `password_hash='invited_pending'` → `'invited'`, else `'active'` — otherwise never-accepted invitees appear as joined members and resend breaks. Requires-infra assertion included. **Sentinel dichotomy (one sentence, so nobody half-migrates):** `INVITED_PENDING_PASSWORD` keeps meaning "this ACCOUNT has no credentials yet"; `membership.status` owns "is this person in this WORKSPACE" — the three sentinel consumers (`toTenantUserProfile`, `inviteWorkspaceMember`, `resendWorkspaceInvitation`) are all converted in Phase 2, and the **resend gate moves to `membership.status`** (today it reads the sentinel projection, which would make resend impossible for an active account invited to a second org).
3. **Phase 0.5 absorb — three holes closed (Claude E2, HIGH):** (a) the full orphan predicate is **re-checked inside the accept transaction** (invite-time check is advisory); on failure → terminal "this workspace is now in use" state, no repoint; (b) absorb **moves the membership row in the same transaction** as the pointer repoint (else pointer→B with membership→A resolves as NULL at flip); (c) absorb accept **requires a signed-in session matching the invited email** — same consent-auth rule as the Phase 2 page, stated here because 0.5 ships first.
4. **Last-admin guard needs per-org serialization (Claude E3):** symmetric concurrent demotes (A demotes B while B demotes A) both pass a plain `WHERE EXISTS` under READ COMMITTED → zero admins. The conditional write is preceded by `SELECT … FOR UPDATE` on the org's active-admin membership rows (or `pg_advisory_xact_lock(org_id)`). Two-concurrent-demotes race test required.
5. **Accept transaction semantics pinned (Codex #4):** the accept txn locks invitation-by-token + user + membership rows, re-checks `accepted_at`/expiry/membership status/credential state inside the txn, and updates exactly that `(user, organization)` membership; the token loader starts selecting `organization_id`. A fully-pending user who accepts two invites in parallel gets a **visible** existing-account variant on the second ("sign in with the password you just set"), never a silent password discard.
6. **Cross-org concurrent FIRST invite (Codex #3):** two admins in different orgs inviting the same brand-new email race the `users.email` UNIQUE constraint (the existing-user SELECT runs before `BEGIN`) — user creation becomes create-or-select with `ON CONFLICT (email)` so the loser attaches a membership to the winner's user row instead of 500ing.
7. **Case-insensitive email uniqueness (Codex #5, latent today):** `users.email` is `TEXT UNIQUE` while every lookup uses `LOWER(email)` and credentials signup does not normalize before insert — `Foo@x.com` + `foo@x.com` can already produce two accounts, and multi-membership makes one-email-one-account load-bearing. Phase 0 adds a lowercase unique index (`CREATE UNIQUE INDEX … ON users (LOWER(email))` after a dedupe audit) and signup normalizes on write.
8. **jwt hydrate must CLEAR stale claims (Claude A2):** `hydrateTenantClaimsByUserId` only ever sets claims (early-returns on missing/incomplete) — fine today, wrong once "removed from active workspace → NULL pointer" is reachable: ghost `tenantId`/`tenantRole` would live in the token indefinitely and feed the DB-outage fallback. Phase 1 makes the hydrate clear tenant claims when membership resolution returns none; test included.
9. **Zero-membership blast radius (Claude E5):** `enforceOnboardingGate` maps any `TenantContextError` → onboarding, whose resume page **mints an org** — silently resurrecting auto-provisioning through a different door. The gate gets an explicit zero-membership branch → chooser; the chooser lives OUTSIDE the gated dashboard layout; API routes surface `403 tenant_membership_missing` for the state.
10. **Role-mirror WRITE sites gated too (BOTH voices):** the lint gate covers writes as well as reads — `users.role` writers today: `updateTenantUserProfile:174-189` (must also sync the mirror when editing the ACTIVE workspace's membership), `resolveTenantForDraft` (both branches), `assignUserToOrganization:104-109`, `ensureTenantAccessForUser` (dev), `seed-qa-tenant.ts`. A missed write site flag-ON produces reverse drift (mirror fresh, membership stale).
11. **No role default on the membership table (Claude A3):** `users.role` has `DEFAULT 'tenant_admin'` — a prod landmine this plan does not replicate. `organization_memberships.role` has **no default**; every insert sets it explicitly.
12. **Claims-fallback trade documented (Claude S2):** during a DB blip the resolver serves stale session claims — a just-removed member can read (and the guard can pass) against their old workspace for the blip's duration. Accepted as availability-over-consistency for reads; **mutating requests fail closed when resolution used the fallback** (the guard cannot verify membership without the DB anyway).
13. **jwt query budget (Claude, perf):** the jwt callback re-hydrates on every `auth()` call and server trees call `auth()` several times per render — the Phase 1 join must be the SAME single query as the resolver's, and `workspaceCount` rides that query (no second aggregate query per token access). Phase 1 includes the full-endpoint p99 benchmark (guardrail #1), flag ON vs OFF.
14. **Consolidation is a Phase 1 PRECONDITION (Claude A1):** the claims join is triplicated today; consolidating to one helper lands before or with the flag fork — forking three copies and golden-testing one is how drift ships.

## Architecture (Section 1)

```
                       ┌─────────────────────────────────────────────────┐
                       │  organization_memberships (NEW)                 │
                       │  (user_id, org_id) PK · role · status ·         │
                       │  last_active_at · invited_by · timestamps       │
                       │  + organization_membership_events (NEW, audit)  │
                       └────────▲──────────────────▲─────────────────────┘
                                │                  │
             ┌──────────────────┴────┐      ┌──────┴───────────────────────┐
             │ lib/auth-tenant-      │      │ backend/tenant/              │
             │ membership.ts (MOD)   │      │ workspace-invitations (MOD)  │
             │ ONE membership-claims │      │ 2nd-membership invites ·     │
             │ helper (kills the     │      │ consent accept split ·       │
             │ 3-way join triplication)│    │ (user,org)-scoped tokens ·   │
             └────────▲──────────────┘      │ absorb-orphan (Phase 0.5)    │
                      │                     └──────▲───────────────────────┘
        ┌─────────────┴──────────┐          ┌──────┴────────────────┐
        │ auth.ts (MOD)          │          │ backend/tenant/       │
        │ signIn guard · jwt     │          │ user-profiles.ts (MOD)│
        │ re-hydrate (unchanged  │          │ list/create/role via  │
        │ mechanism)             │          │ membership · delete=   │
        └────────▲───────────────┘          │ membership row only   │
                 │                          └──────▲────────────────┘
   ┌─────────────┴────────────┐             ┌──────┴─────────────────────┐
   │ lib/tenant-context.ts    │             │ app/api/tenant/workspace/  │
   │ (MOD) validate pointer   │             │ switch (NEW) txn: pointer  │
   │ + role in ONE join       │             │ + role mirror + audit log  │
   └─────────────▲────────────┘             └──────▲─────────────────────┘
                 │ x-aries-workspace-id 409 guard   │
   ~43 API routes (UNCHANGED, inherit) · app-shell rail switcher +
   stale-workspace interlock (NEW UI) · consent/chooser pages (NEW UI)
```

Coupling: the resolver gains exactly one new dependency (memberships) via one helper; nothing else couples. No new SPOF, pools, workers, or external calls. Rollback: flag OFF (Phases 1–4); schema is additive (no rollback needed); Phase 0.5 rollback = revert PR.

## Test plan
Full test diagram (27 rows + the eng-voice additions below), 2am/hostile/chaos tests, pinned-test blast radius, pyramid, and the Phase-1 endpoint benchmark requirement live in the artifact: `~/.gstack/projects/DeliciousHouse-aries-app/hermes-claude-reverent-edison-512979-test-plan-20260703-162700.md`. Summary: ~30 unit / ~7 route / 3 requires-infra; the flag-OFF golden suite is written BEFORE the resolver refactor; `tests/auth/integrations-tenant-context.test.ts` is pre-existing red (TODOS.md P0) and must be fixed or quarantined before Phase 1 so this program's diffs aren't blamed for it.

**Eng-voice test additions:** structural mutation-guard test (inv-01b pattern — every mutating handler reaches the mismatch check); symmetric concurrent admin demote; accept-vs-revoke race ("invitation revoked", not silent 0-row success); resend-to-existing-account invitee; absorb-eligibility re-check inside the accept txn; zero-membership → onboarding-gate → chooser (asserting NO org row is created); jwt hydrate clears claims on membership removal; backfill sentinel mapping (`invited_pending`→`'invited'`, requires-infra); cross-org concurrent first invite (ON CONFLICT create-or-select); case-variant email signup/invite; missing `x-aries-workspace-id` on mutations flag-ON; role-mirror sync on active-workspace role edit.

**Full pinned-test inventory (both voices):** the five files listed in Test strategy PLUS `tests/auth/tenant-session-claims.test.ts` (workspaceCount augment lands here), `tests/auth/auth-user-journey.test.ts`, `tests/auth/workflow-route-tenant-context.test.ts`, and `tests/prd-invariants/inv-01b-state-mutating-routes-auth-gate.test.ts` (its `AUTH_GATE_PATTERNS` must learn the switch endpoint + guard helper or CI fails structurally).

## Worktree parallelization strategy
Phases are sequential by dependency (0 → 0.5 → 1 → 2 → 3 → 4 → 5); within a phase, test authoring can run in a parallel worktree against the phase's interface contract. Do NOT parallelize Phase 1 and Phase 2 — both edit `workspace-invitations.ts`/`user-profiles.ts` seams and this repo has documented merge-skew incidents on shared seams (#677).

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | Intake | DX review phase skipped | Mechanical | P3 | grep over-match; internal app routes, no developer-facing product surface | Running Phase 3.5 |
| 2 | CEO 0C-bis | Approach A (memberships + pointer) | Mechanical | P1+P5 | B fails the stated requirement; C fights the verified resolver | B, C |
| 3 | CEO 0D | E1 last_active_at accepted | Mechanical | P2 | in blast radius, 1 column, resolves OQ2 | oldest-membership default |
| 4 | CEO 0D | E3 membership audit trail accepted | Mechanical | P1/P2 | observability + security both require it | logs-only |
| 5 | CEO 0D | E4 last-admin guard accepted | Mechanical | P1 | prevents unadministrable workspaces | none |
| 6 | CEO 0D | E5 rejected as duplicate | Mechanical | P4 | already plan Decision 4 | — |
| 7 | CEO 0D | E7 notification prefs + org-delete UI deferred | Mechanical | P3 | outside blast radius | building now |
| 8 | CEO 0D | E2 pending-invites-in-switcher | **TASTE → gate** | — | borderline scope on switcher surface | — |
| 9 | CEO 0D | E6 self-service leave | **TASTE → gate** | — | borderline scope, symmetric with remove | — |
| 10 | CEO S2 | Accept TOCTOU re-check inside txn | Mechanical | P1 | account-takeover class; masked today by email_taken | pre-txn check |
| 11 | CEO S2 | ON CONFLICT idempotent duplicate invite | Mechanical | P1 | concurrent admins must not 500 | first-wins error |
| 12 | CEO S2 | Switch = single txn (pointer + role mirror) | Mechanical | P1 | closes role/pointer skew window | two writes |
| 13 | CEO S5 | Consolidate 3 claims queries into one helper | Mechanical | P4 | membership join must exist in exactly one place | per-site edits |
| 14 | CEO F1 | Mutation guard + stale-tab detector required Phase 3 | Mechanical | P1 | multi-tab switch = publish-to-wrong-workspace hazard | ship switcher bare |
| 15 | CEO F1/F3 | URL-scoped tenancy deferred w/ ADR | Mechanical | P3+P5 | XL migration; guard covers the write hazard now | URL-scope now |
| 16 | CEO F2 | Phase 0.5 absorb-orphan interim relief added | Mechanical | P2+P6 | removes manual-SQL class in days; strictly bounded | wait for Phase 2 |
| 17 | CEO F2/Codex | Zero-membership chooser replaces silent auto-provision (flag ON) | Mechanical | P1 | both voices: eager provisioning is the root cause | keep auto-mint |
| 18 | CEO F4 | Honest justification reframe (seam-first, security, #14) | Mechanical | P5 | agency demand is unevidenced; don't let it carry the plan | agency framing |
| 19 | CEO F5 | Phase 5 flag retirement numbered into scope | Mechanical | P2 | auth-path flags must not live forever in this repo | prose follow-up |
| 20 | CEO F6 | Hybrid credential-state test matrix | Mechanical | P1 | password path unreachable for any active credential | per-invite tests |
| 21 | CEO S3 | OQ1 consent-accept ratified (security-required) | Mechanical | P1 | auto-add = mutual visibility without consent | auto-add |
| 22 | Design P1 | Rail-top workspace identity + mobile header (OQ3) | Mechanical (cross-model) | P5 | both voices: "top bar" doesn't exist; settings-only buries the safety boundary | top-bar, settings-only |
| 23 | Design P3 | Stale-workspace interlock (alertdialog, no auto-nav, 409 routes into it) | Mechanical | P1 | wrong-workspace publish class; toast too weak; unsaved work survives | toast, in-content banner |
| 24 | Design P3 | Consent page: sign-in required + 4 states + disclosure | Mechanical | P1 | token possession ≠ consent; rubber-stamp page defeats OQ1 | token-only accept |
| 25 | Design P3 | Chooser is invite-aware (pending invite = primary) | Mechanical | P1 | else invited users hit a dead end | equal-weight buttons |
| 26 | Design P3 | Switch = hard-navigate to new /dashboard | Mechanical | P5 | route preservation points at cross-tenant data | preserve route |
| 27 | Design J-c | Create-workspace moved to account menu (not switcher) | Mechanical | P1 | switcher renders only at N>1 — create would be unreachable | switcher-hosted create |
| 28 | Eng S0 | Guard moved inside getTenantContext() + structural test | Mechanical (cross-model) | P1 | 12 mutating routes bypass the wrapper | wrapper-level guard |
| 29 | Eng E1 | Dual-write + resolver self-heal + pre-flip backfill re-run | Mechanical (cross-model) | P1 | continuous dark-period drift; live-JWT users never self-heal | sign-in-only heal |
| 30 | Eng S1 | Backfill maps pending sentinel → status='invited' | Mechanical | P1 | else never-accepted invitees appear joined; resend breaks | uniform 'active' |
| 31 | Eng E2 | Absorb: in-txn predicate re-check + membership move + signed-in consent | Mechanical | P1 | three flip-day/consent holes in Phase 0.5 | invite-time check only |
| 32 | Eng E3 | Last-admin guard gets per-org FOR UPDATE serialization | Mechanical | P1 | symmetric demotes → zero admins under READ COMMITTED | WHERE EXISTS only |
| 33 | Eng E4/#3/#4 | Lock-based accept txn; org-scoped consume; cross-org first-invite ON CONFLICT | Mechanical | P1 | invitation state-machine races | pre-txn checks |
| 34 | Eng #5 | Lowercase unique email index + normalize-on-write | Mechanical | P1 | latent dup-account hole becomes load-bearing | leave as-is |
| 35 | Eng A2/E5 | jwt hydrate clears stale claims; onboarding gate zero-membership branch | Mechanical | P1 | ghost claims + resurrected auto-provisioning | set-only hydrate |
| 36 | Eng S2 | Mutations fail closed on claims-fallback resolution | Mechanical | P1 | stale-claims blip must not permit writes | fail-open (reads keep fallback) |
| 37 | Eng A1/#6 | Claims consolidation = Phase 1 precondition; role-mirror WRITES gated | Mechanical | P4/P1 | fork-three-golden-one drift; reverse mirror drift | consolidate later |
| 38 | Gate D2 | REVISION: multi-workspace = paid entitlement (Decision 13) | **Owner decision** | — | Aries free tier = one workspace per account | free multi-workspace |
| 39 | Revision | Entitlement = users.plan + one server-side helper at 3 choke points; absorb + first-membership stay free | Mechanical | P5 | account-level per owner's framing; payments PR later swaps only the writer | per-workspace billing now |
| 40 | Revision | v1 counts ALL active memberships toward the paid limit | Mechanical (relaxable) | P5 | owner's literal framing; owned-only variant is a one-predicate change | owned-workspaces-only |
| 41 | Gate D3 | E2 pending-invites-in-switcher ACCEPTED | **Owner decision** | — | gate answer | defer |
| 42 | Gate D4 | E6 self-service leave ACCEPTED | **Owner decision** | — | gate answer | defer |

# Taste/Honcho per-brand learning — VERIFIED (owner revision request, 2026-07-03)

**Claim checked:** the AI agent's taste/preference learning is scoped per-BRAND (tenant), never per-user — so under multi-workspace, brand A's learned taste can never contaminate brand B's content. **Verdict: CONFIRMED**, code-verified to the line + live prod DB spot-check.

- **Generation READ path is tenant-only:** the weekly brief preload is `loadTasteForBriefByTenant(input.tenantId)` (`backend/marketing/ports/hermes.ts:725-731`) → `getTasteForTenant` reads ONLY the `tenant_id = $1 AND user_id IS NULL` row (`backend/marketing/taste-profile-store.ts:374-396`); the per-user readers (`getTasteProfile`/`loadTasteForBrief`) have **zero callers**. No user-scoped row feeds generation.
- **WRITE paths:** all weekly-loop producers (review approve/reject, regenerate, image-edit, post delete) go through `applyTenantTasteSignal` — tenant-scoped, no userId parameter exists. The only `(tenant_id, user_id)` writer is the onboarding variant board — still brand-partitioned by the composite key, and unread by generation.
- **Honcho:** workspace = `aries-tenant-<HMAC(tenantId)>` (`backend/memory/pseudonym.ts:41-46`) — hard per-brand isolation; the Honcho client derives the workspace exclusively from `ctx.tenantId` with a `workspace_lockin_violation` guard. Honcho reads into generation (`loadMemoryContext`) are workspace-scoped (and on Honcho v3 currently return `[]` — isolation holds by construction regardless).
- **Live prod:** `marketing_taste_profile` contains exactly one row — `tenant_id=60, user_id=NULL` (tenant 60 = Hammad; tenant-scoped as designed). `marketing_taste_signal` is schema-live, writer-dead (0 rows).
- **One latent (inert) hazard + cheap hardening (added to Phase 1 scope):** two synthetic contexts pass `userId: tenantId` (`backend/memory/write-events.ts:732`, `scripts/automations/honcho-performance-worker.ts:156`). Today neither reaches a user peer (verified: `recordPerformanceEvent` never reads `ctx.userId`), but `pseudonymForUser("15")` cannot distinguish tenant 15 from user 15 — under multi-workspace a (user N ∈ tenant N) pair becomes possible and a future refactor could merge a synthetic peer with a real person's. Hardening: replace the synthetic `userId: tenantId` fields with the `'system'` sentinel; add the domain-separation pin test.
- **Isolation pin tests added to Test strategy:** two-tenant taste independence (same user, tenants A+B → independent rows; A's signal never surfaces in B's brief); brief non-contamination golden; read-path scope pin (`user_id IS NULL` predicate); pseudonym domain-separation guard; Honcho workspace-isolation transport test (same user, two tenants → two workspace paths).

## Implementation Tasks
Synthesized from review findings across all phases (aggregated; full JSONL in `~/.gstack/projects/DeliciousHouse-aries-app/tasks-*-review-*.jsonl`). P1 blocks the phase it belongs to; P2 lands in-phase; P3 is follow-up.

**P1:** consent-accept split w/ in-txn TOCTOU re-check (invite/accept) · membership-validated single-query resolution + claims consolidation (resolver) · switch endpoint txn + guard + interlock (switch) · Phase 0 dark schema + backfill + indexes (schema) · rail-top workspace identity + mobile header (shell) · stale-workspace interlock w/ 409 routing (shell) · consent page: sign-in required + 4 states + disclosure (consent) · guard inside `getTenantContext()` + structural test (guard) · dual-write + self-heal + pre-flip backfill + sentinel mapping (drift) · lock-based accept txn + cross-org first-invite ON CONFLICT (accept) · lowercase-unique email index + normalize-on-write (email)

**P2:** membership-delete remove + last-admin guard w/ per-org FOR UPDATE (member CRUD) · zero-membership chooser + absorb-orphan flow (provisioning) · Phase 5 flag retirement + role-mirror write gating (flag lifecycle) · invite-aware chooser (chooser) · switch transition UX (switcher) · jwt hydrate clears claims + workspaceCount on the hydrate query + p99 benchmark (jwt) · onboarding-gate zero-membership branch (gate)

**P3:** audit/repair auto-provisioned org display names before the switcher ships (data hygiene)

## Cross-phase themes (flagged independently by 2+ phases' voices — highest-confidence signals)
1. **Eager org auto-provisioning is the root cause of the orphan-workspace class** — CEO Codex + CEO Claude + Eng Claude (E5: the onboarding gate would resurrect it). Resolved: zero-membership chooser + gate branch + no silent minting anywhere flag-ON.
2. **The single global active-pointer is hazardous for writes** — CEO Claude F1 (multi-tab publish) + Eng both voices (guard coverage). Resolved: guard inside `getTenantContext()` + interlock + structural test.
3. **Consent must be invitee-side, everywhere** — CEO S3 (OQ1), spec-review iteration 2 (Phase 0.5 hole), Design Claude (rubber-stamp page), Eng Claude E2c (absorb auth). Resolved: signed-in consent for every account-affecting accept, including absorb.
4. **Transitional duality rots (flag paths, role mirror, sentinel/status)** — CEO Claude F5 + Eng both voices. Resolved: Phase 5 numbered retirement, write+read lint gates, sentinel dichotomy sentence, consolidation-before-fork.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open (PLAN via /autoplan) | 7 proposals, 3 accepted, 2 deferred; premises user-confirmed; 6 voice findings folded |
| Codex Review | `/codex review` | Independent 2nd opinion | 3 | issues_found (via /autoplan, all phases) | CEO 6 verdicts adversarial; design: shell-anatomy catch; eng: guard coverage + 5 findings |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN via /autoplan) | 20 issues found, 20 folded into plan, 0 critical gaps remaining |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN via /autoplan) | score: 4/10 → 8/10, 8 decisions; mockups skipped (no OpenAI key for designer) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | SKIPPED | no developer-facing scope (internal app routes only) |

- **CODEX:** ran in all three phases; sharpest catches: eng guard-coverage overclaim (converged with Claude subagent), cross-org first-invite race, case-insensitive email hole, design shell-anatomy error.
- **CROSS-MODEL:** exceptional convergence — both models independently found the guard placement flaw, the dark-period drift, the eager-provisioning root cause, and the nonexistent top bar. One severity disagreement (CEO scope calibration: Claude partial vs Codex no) → absorbed into the honest-justification reframe.
- **VERDICT:** ENG + DESIGN CLEARED; CEO issues_open pending the final-gate taste decisions below — ready for Brendan's approval gate; do NOT build yet (owner instruction).

**REVISION (2026-07-03, owner):** (1) multi-workspace gated behind a paywall → Decision 13 (entitlement seam, `users.plan`, 402 semantics, upgrade screen; payments integration remains follow-up scope); (2) taste/Honcho per-brand learning **verified** (see the verification section — CONFIRMED, with isolation pin tests + one latent-hazard hardening added to scope).

NO UNRESOLVED DECISIONS
