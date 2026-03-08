# agent-provisioning-builder log

## Summary
Implemented tenant agent provisioning spec and three agent builders (`core`, `marketing`, `research`) in bounded scope.

## What was added
- `specs/agent_provisioning_spec.v1.json`
- `backend/agents/create-core-agent.ts`
- `backend/agents/create-marketing-agent.ts`
- `backend/agents/create-research-agent.ts`

## Key guarantees
- Explicit hard failure when `./specs/tenant_runtime_state_schema.v1.json` is missing.
- Explicit hard failure when validated workspace artifact `generated/validated/{tenantId}/config/workspaces.json` is missing.
- Workspace path is derived from validated `workspace_paths` mapping and must start with `workspaces/`.
- Deterministic agent id format: `{tenantId}-{agentType}-agent`.

## Validation run
- JSON parse check: pass
- TS type check: `bunx tsc --noEmit backend/agents/create-core-agent.ts backend/agents/create-marketing-agent.ts backend/agents/create-research-agent.ts` (pass)
