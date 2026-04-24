# Canonical Workspace And Artifact Governance

## Purpose

Aries has one canonical code workspace for repo-managed product work:

- Canonical repo root: `/app/aries-app`
- Canonical git root: `/app/aries-app/.git`

Any additional `aries-app` trees outside that root are recovery artifacts, not primary execution roots, unless `ARIES_CANONICAL_REPO_ROOT` explicitly overrides the default.

## Canonical Path Contract

All coding agents must satisfy these rules:

1. `cwd` resolves to `/app/aries-app`
2. `git rev-parse --show-toplevel` resolves to `/app/aries-app`
3. Startup checks confirm the expected top-level markers exist:
   - `package.json`
   - `VERSION`
   - `app/`
   - `backend/`
   - `tests/`
4. Product code edits happen only inside the canonical repo root.
5. Agent instructions that govern repo behavior must exist as tracked files inside the repo.

## Agent Workspace Standard

For local agents:

- `adapterConfig.cwd` should point to `/app/aries-app` unless `ARIES_CANONICAL_REPO_ROOT` intentionally overrides it.
- Recovery or personal state may live outside the repo, but product code does not.

This separates product code from personal state:

- Product code: `/app/aries-app`
- Personal / runtime state: external to the repo

## Startup Verification Ritual

Run this before substantive repo work:

```bash
npm run workspace:verify
```

The repo-level [AGENTS.md](/app/aries-app/AGENTS.md) makes this ritual part of the shared execution contract for agents working from the canonical repo.

The verification fails hard if:

- the current directory is not inside the canonical repo
- the detected git root does not match the canonical root
- required top-level markers are missing

## Recovery And Quarantine Policy

Duplicate `aries-app` trees outside `/app/aries-app` are treated as recovery sources.

Required handling:

1. Inventory them with `npm run workspace:inventory`
2. Classify each tree:
   - `canonical_match`: same HEAD and clean
   - `dirty_recovery_candidate`: has uncommitted changes
   - `stale_clone`: clean but HEAD differs from canonical
   - `agent_home_only`: workspace exists but no repo clone is present
3. Do not merge or delete directly from those trees
4. Copy candidate files into a recovery folder or dedicated recovery branch before review
5. Review diffs against canonical before any integration

Recommended recovery folder:

- `recovery/paperclip-workspaces/<workspace-id>/`

## Current Truth

Current repo truth is defined by the live git root at `/app/aries-app` unless `ARIES_CANONICAL_REPO_ROOT` is deliberately set to a different checked repo root.

Historical inventories of older workspace layouts may still exist under `docs/operations/`, but they are snapshots, not current path truth.

## Decision Rule

If a file exists both in canonical and in a duplicate workspace tree:

- canonical stays authoritative
- duplicate content must be reviewed as a candidate patch, never assumed to be the source of truth
