# Canonical Workspace And Artifact Governance

## Purpose

Aries has one canonical code workspace for repo-managed product work:

- Canonical repo root: `/home/bkam/docker-stack/aries-app`
- Canonical git root: `/home/bkam/docker-stack/aries-app/.git`

Any additional `aries-app` trees under Paperclip agent homes or workspace folders are recovery artifacts, not primary execution roots.

## Canonical Path Contract

All coding agents must satisfy these rules:

1. `cwd` resolves to `/home/bkam/docker-stack/aries-app`
2. `git rev-parse --show-toplevel` resolves to `/home/bkam/docker-stack/aries-app`
3. Startup checks confirm the expected top-level markers exist:
   - `package.json`
   - `README-runtime.md`
   - `app/`
   - `backend/`
   - `tests/`
4. Product code edits happen only inside the canonical repo root.
5. Agent instructions remain under each agent's personal folder at:
   - `$AGENT_HOME/agents/<agent-key>/AGENTS.md`

## Agent Workspace Standard

For local Codex agents:

- `adapterConfig.cwd` must point to `/home/bkam/docker-stack/aries-app`
- `instructionsFilePath` should point into the CEO workspace under `agents/<agent-key>/AGENTS.md`
- Personal memory stays under the agent home, not in the repo root

This separates product code from personal state:

- Product code: `/home/bkam/docker-stack/aries-app`
- CEO home: `/home/bkam/.paperclip/instances/default/workspaces/9456b509-01f4-40ac-96ce-4dba2a28d2eb`

## Startup Verification Ritual

Run this before substantive repo work:

```bash
npm run workspace:verify
```

The repo-level [AGENTS.md](/home/bkam/docker-stack/aries-app/AGENTS.md) makes this ritual part of the shared execution contract for agents working from the canonical repo.

The verification fails hard if:

- the current directory is not inside the canonical repo
- the detected git root does not match the canonical root
- required top-level markers are missing

## Recovery And Quarantine Policy

Duplicate `aries-app` trees under `/home/bkam/.paperclip/instances/default/workspaces/*/aries-app` are treated as recovery sources.

Required handling:

1. Inventory them with `npm run workspace:inventory`
2. Classify each tree:
   - `canonical_match`: same HEAD and clean
   - `dirty_recovery_candidate`: has uncommitted changes
   - `stale_clone`: clean but HEAD differs from canonical
   - `non_repo_artifact`: path exists without a git repo
3. Do not merge or delete directly from those trees
4. Copy candidate files into a recovery folder or dedicated recovery branch before review
5. Review diffs against canonical before any integration

Recommended recovery folder:

- `recovery/paperclip-workspaces/<workspace-id>/`

## Current March 16, 2026 Snapshot

`npm run workspace:inventory` currently shows:

- canonical repo root at `/home/bkam/docker-stack/aries-app`
- duplicate repos under:
  - `/home/bkam/.paperclip/instances/default/workspaces/e0aa8301-e592-4127-a221-cd1664e6aca2/aries-app`
  - `/home/bkam/.paperclip/instances/default/workspaces/e5d78f85-4ba6-4278-a516-e24b33bec381/aries-app`
- both duplicate repos are on commit `79eb294a0420820ef905a630e811358bf7a224f0`
- canonical repo is on commit `bfd978cb4f88b013e1a346096a253928ac76b78c`
- the CTO duplicate repo is dirty and contains integration-route edits that must be treated as recovery material, not authoritative product state

## Decision Rule

If a file exists both in canonical and in a duplicate workspace tree:

- canonical stays authoritative
- duplicate content must be reviewed as a candidate patch, never assumed to be the source of truth
