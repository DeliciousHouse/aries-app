# Tenant Context Milestone Decision

## Decision

The next smallest milestone for Aries is:

`tenant context propagation and isolation validation for the current single-org-per-user model`

This stays aligned to:
- tenant isolation
- auth/OAuth
- client profile/workspace
- QA/security

## Why This Comes First

Repo-managed Lobster and OpenClaw workflow execution is already starting to take shape, but it depends on a hard tenant boundary first.

The current in-flight code is directionally correct:
- `auth.ts` hydrates tenant claims into auth state
- `lib/tenant-context.ts` resolves tenant context from session claims with DB fallback
- `app/api/tenant/profiles/*` scopes profile APIs to the authenticated tenant
- `backend/tenant/user-profiles.ts` blocks cross-tenant reads, writes, and deletes

This is the right de-risking slice before pushing deeper into workflow execution or OAuth expansion.

## Current Validation

Validated locally with the repo test harness:
- `npm test -- tests/auth/tenant-context.test.ts tests/auth/tenant-session-claims.test.ts tests/tenant/user-profiles-isolation.test.ts tests/tenant/repo-workflows-approval.test.ts`
- `npm run typecheck`

Current result:
- targeted tenant/auth/workflow tests pass
- typecheck passes

## Constraints

This milestone is explicitly Phase 1 and not the final tenant model.

Current working assumption:
- one user belongs to one organization through `users.organization_id`
- tenant-scoped authorization is derived from `users.role`

This is acceptable only as a bounded interim model for Phase 1 hardening.

## Escalations Required Before Declaring Complete

The following remain escalated decisions and must not be treated as implicit approval:

1. Auth/session contract change
- Adding `tenantId`, `tenantSlug`, and `tenantRole` to JWT/session state changes the auth boundary.

2. Canonical tenant identity model
- The current implementation is tenant-scoped, but not true multi-membership tenancy.
- Any move to tenant memberships, invitation state, or a separate membership table is a schema and auth decision.

## Execution Order

1. Finish tenant-context hardening and isolation validation.
2. Hold the repo-managed workflow control plane behind that boundary.
3. Then wire actual OpenClaw/Lobster execution and replace broken legacy execution paths in repo-managed form.

## Exit Criteria For This Milestone

- tenant context is derived from authenticated state, not caller-supplied tenant ids
- tenant profile APIs reject cross-tenant access
- sensitive workflow approval routes remain tenant-admin scoped
- automated tests prove the covered tenant boundary behavior
- auth/session claim changes are explicitly approved
