# Paperclip Workspace Inventory

Date: 2026-03-16

## Canonical Repo

- Path: `/home/bkam/docker-stack/aries-app`
- Branch: `master`
- HEAD: `bfd978cb4f88b013e1a346096a253928ac76b78c`

## Workspace Findings

### `e0aa8301-e592-4127-a221-cd1664e6aca2`

- Path: `/home/bkam/.paperclip/instances/default/workspaces/e0aa8301-e592-4127-a221-cd1664e6aca2/aries-app`
- Classification: `stale_clone`
- Branch: `master`
- HEAD: `79eb294a0420820ef905a630e811358bf7a224f0`
- Worktree state: clean
- Action: keep out of the execution path; use only as recovery input if a missing change is later discovered

### `e5d78f85-4ba6-4278-a516-e24b33bec381`

- Path: `/home/bkam/.paperclip/instances/default/workspaces/e5d78f85-4ba6-4278-a516-e24b33bec381/aries-app`
- Classification: `dirty_recovery_candidate`
- Branch: `master`
- HEAD: `79eb294a0420820ef905a630e811358bf7a224f0`
- Worktree state: dirty
- Modified files:
  - `app/api/integrations/disconnect/route.ts`
  - `app/api/integrations/route.ts`
  - `app/api/integrations/sync/route.ts`
  - `app/api/platform-connections/route.ts`
  - `frontend/settings/integrations.tsx`
  - `lib/tenant-context-http.ts`
  - `tests/auth/integrations-tenant-context.test.ts`
- Action: treat as quarantined recovery material; diff and port intentionally into canonical only after review

### `9456b509-01f4-40ac-96ce-4dba2a28d2eb`

- Path: `/home/bkam/.paperclip/instances/default/workspaces/9456b509-01f4-40ac-96ce-4dba2a28d2eb`
- Classification: `agent_home_only`
- Notes: contains CEO memory, plans, and agent instruction files; not a duplicate repo root

## Immediate Controls

1. Use `/home/bkam/docker-stack/aries-app` as the only repo root for product work.
2. Require `npm run workspace:verify` before substantive agent execution.
3. Use `npm run workspace:inventory` to re-check drift before merging recovery content from duplicate workspace repos.
