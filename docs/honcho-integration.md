# Honcho Memory Integration

## Overview

Aries uses Honcho as a tenant-scoped long-term memory layer. Each organization gets an isolated workspace. Approved research findings (brand facts, policy constraints) are stored there and loaded back into Hermes runs to give the AI accumulated context across sessions.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HONCHO_ENABLED` | Yes (for memory) | Master gate. `true`/`1`/`yes`/`on` enables all Honcho writes and reads. |
| `HONCHO_BASE_URL` | Yes when enabled | Honcho API base URL. Dev default: `http://host.docker.internal:8000`. |
| `ARIES_TENANT_PSEUDONYM_SALT` | Yes when enabled | ≥16-char HMAC secret for deterministic tenant workspace IDs. Never reuse between environments. |
| `HONCHO_CONTROL_PLANE_JWT` | Production | JWT for workspace create/delete operations. Falls back to data-plane token if absent. |
| `HONCHO_DATA_PLANE_JWT` | Production | JWT for routine Honcho API calls. Falls back to control-plane token if absent. |
| `ARIES_RESEARCH_ENABLED` | For research dispatch | Sub-gate for dispatching research jobs to Hermes. Requires `HONCHO_ENABLED=true` to be useful. |
| `HERMES_RESEARCH_WEBHOOK_URL` | For research dispatch | Hermes endpoint for research runs. Typically `http://host.docker.internal:8642/v1/runs`. |

Dev `.env` (already configured):
```bash
HONCHO_ENABLED=true
HONCHO_BASE_URL=http://host.docker.internal:8000
ARIES_TENANT_PSEUDONYM_SALT=<see .env>
ARIES_RESEARCH_ENABLED=1
HERMES_RESEARCH_WEBHOOK_URL=http://host.docker.internal:8642/v1/runs
```

## Files Changed

| File | Change |
|---|---|
| `backend/memory/honcho-env.ts` | New — `isHonchoEnabled()` + `validateHonchoConfig()` |
| `backend/memory/onboarding-memory-hook.ts` | Gate changed from `isAriesResearchEnabled` to `isHonchoEnabled` |
| `backend/memory/index.ts` | Exports `isHonchoEnabled` and `validateHonchoConfig` |
| `backend/marketing/ports/hermes.ts` | `loadMemoryContext()` + memory context injection into run payloads |
| `.env` | Added 5 new variables (see above) |
| `tests/memory-honcho-env.test.ts` | New — tests for gate + validation + isolation contracts |
| `docs/honcho-integration.md` | This file |

## Tenant Isolation

Every organization gets a workspace ID derived by:
```
workspace_id = "aries-tenant-" + HMAC-SHA256(ARIES_TENANT_PSEUDONYM_SALT, tenantId)[0:32]
```

The `TenantMemoryClient` enforces that all paths start with `aries-tenant-` before making any request (`workspace_lockin_violation` error on violation). No cross-tenant reads are possible through this client.

## Peer and Session Model

**Peers** (memory buckets within a workspace):
- `peer-brand` — first-party brand facts, voice, identity
- `peer-policy` — operational constraints, approval rules
- `peer-user-{pseudonym}` — user-specific preferences
- `peer-competitor-{pseudonym}`, `peer-audience-{segmentId}`, `peer-market-signal-{pseudonym}`

**Sessions** (conversation threads):
- `session-onboarding-{runId}` — first-run brand profile seed
- `session-curated-{jobId}` — research findings per marketing job
- `session-strategy-{jobId}` — strategy-stage context

## Local Run Instructions

1. Ensure Honcho is running: `docker ps | grep honcho-api`
2. Verify health: `curl http://localhost:8000/health`
3. Start Aries: `docker compose up aries-app`
4. Trigger a marketing run with a brand URL; the onboarding seed will fire after the dashboard gate if `HONCHO_ENABLED=true` and the org has not been seeded yet.

## Verifying Writes

Check workspace creation:
```bash
curl http://localhost:8000/v3/workspaces
```

List sessions in a workspace (replace `<workspace_id>` with the HMAC-derived ID):
```bash
curl "http://localhost:8000/v3/workspaces/<workspace_id>/sessions"
```

List messages in a session:
```bash
curl "http://localhost:8000/v3/workspaces/<workspace_id>/sessions/<session_id>/messages"
```

Compute a workspace ID for a tenant:
```bash
node -e "
const { createHmac } = require('crypto');
const salt = process.env.ARIES_TENANT_PSEUDONYM_SALT;
const tenantId = '1'; // replace with actual org ID
const hash = createHmac('sha256', salt).update(tenantId).digest('hex').slice(0, 32);
console.log('aries-tenant-' + hash);
"
```

## Memory Flow

```
Onboarding gate passes
  → maybeSeedOnboardingMemoryForTenant()
  → Honcho: ensureWorkspace + seedOnboardingMemory (peer-brand, peer-policy)

Marketing job starts
  → runResearchStage() (if ARIES_RESEARCH_ENABLED)
  → submitMarketingResearchMemoryJob()
  → loadResearchMemoryContext() → loads from Honcho
  → dispatchResearchJob() → sends context snapshot + callback URL to Hermes
  → Hermes runs research, POSTs findings to /api/internal/aries-research/callback
  → appendCuratedFinding() → writes curated findings back to Honcho

Hermes marketing run (brand_campaign or weekly_social_content)
  → loadMemoryContext() → loads brand/policy peers
  → Injects memory_context into Hermes payload
```

## Safety Constraints

- No credentials, tokens, or secrets are ever written to Honcho messages
- `redactTokenLikeString()` is applied to all string values in workflow requests
- Honcho failures are non-fatal and never abort an in-progress workflow
- Cross-tenant reads are prevented at the client layer (workspace lock-in check)
- Human approval is required before research findings progress past `queue_for_review`

## Risks and Open Questions

- **JWT auth not enforced in dev**: Both `HONCHO_CONTROL_PLANE_JWT` and `HONCHO_DATA_PLANE_JWT` are unset locally; Honcho accepts requests without auth. Set both for staging/production.
- **Salt rotation**: Rotating `ARIES_TENANT_PSEUDONYM_SALT` will change all workspace IDs, breaking existing memory. Treat the salt as permanent per environment.
- **Weekly social content memory**: Memory context is injected as a top-level `memory_context` field on the Hermes payload; the Hermes workflow must be updated to consume it.
- **Token budget**: Loaded context is capped at 2048 tokens for Hermes runs and 4096 for research dispatch. Tune via `ARIES_RESEARCH_MEMORY_TOKEN_BUDGET`.
