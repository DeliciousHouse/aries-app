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
| `ARIES_HONCHO_BRAND_CONTEXT_ENABLED` | No (default OFF) | Injects the compounding per-brand profile (dialectic answers) into research + strategy submissions. Ships dark; flip on after the write leg has soaked. |
| `ARIES_HONCHO_DIALECTIC_TIMEOUT_MS` | No (default 30000) | Per-call abort timeout for `/chat`. Clamped to 1s..120s. `/chat` is LLM-backed, so 15s clips legitimate answers. |
| `ARIES_INSIGHTS_513_TABLES_PRESENT` | No (default ON) | Insights read-model kill switch. `0` makes the performance write leg do no DB work. Historically this defaulted OFF and had to be set to `1`; that inversion is why the drifted SQL went unnoticed. |
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
| `backend/marketing/ports/hermes.ts` | `loadBrandProfile()` + "Brand memory" injection into research/strategy submissions |
| `backend/memory/honcho-client.ts` | `dialecticQuery()` (v3 `/chat`) + `appendObservation()` (prose) |
| `backend/memory/orchestrator.ts` | `loadBrandProfileContext()` — the two-peer composed profile |
| `backend/memory/perf-insights-read.ts` | due-posts query rewritten against the REAL insights columns + horizon cadence |
| `backend/memory/write-events.ts` | `recordPerformanceEvent()` appends prose to `peer-brand`; returns an outcome; releases the idempotency claim on failure and stamps it completed on success |
| `backend/marketing/hermes-callbacks.ts` | autonomous auto-approve now propagates `tenantSlug` / `memoryActorUserId` |
| `.env` | Added 5 new variables (see above) |
| `tests/memory-honcho-env.test.ts` | New — tests for gate + validation + isolation contracts |
| `docs/honcho-integration.md` | This file |

## Tenant Isolation

Every organization gets a workspace ID derived by:
```
workspace_id = "aries-tenant-" + HMAC-SHA256(ARIES_TENANT_PSEUDONYM_SALT, tenantId)[0:32]
```

The `TenantMemoryClient` enforces that all paths start with `aries-tenant-` before making any request (`workspace_lockin_violation` error on violation). No cross-tenant reads are possible through this client.

## Namespaces (single source of truth)

`aries-tenant-<hmac32>` workspaces are the **only** app-owned namespace. `TenantMemoryClient`
enforces it structurally — any computed workspace id outside that prefix raises
`workspace_lockin_violation` before a request is made, so there is no code path by which
Aries reads or writes anything else.

The live Honcho server also holds:

| Workspace | Owner | Contents |
|---|---|---|
| `aries-tenant-<hmac32>` (one per org) | Aries | brand/policy peers, approvals, denials, performance observations |
| `hermes` | the Hermes gateway | the agent's own conversational memory |
| `test-workspace` | ad-hoc smoke tests | throwaway |

These are **disjoint by design and MUST NOT be merged.** Bridging them server-side would
link pseudonymized tenant identity to raw agent conversation logs, which is exactly the
boundary the HMAC pseudonym exists to draw. The agent side never receives Honcho
credentials.

The bridge that *is* wanted already exists, and it is prompt-side: dialectic answers
drawn from the tenant workspace travel to the agent inside the stage submission
("Brand memory" block). Memory flows agent-ward as data; identity never flows back.

## The compounding brand profile (read leg)

```
POST /v3/workspaces/<ws>/peers/peer-brand/chat    "audience? what content works?"
POST /v3/workspaces/<ws>/peers/peer-policy/chat   "what should be avoided?"
```

Both calls run concurrently, each independently caught, both token-capped into one
`Brand memory` block appended to the research and strategy submissions. Fail-open at every
level: flag off, no tenant, Honcho down, timeout, or an empty representation all render no
block and leave the prompt byte-identical.

This **replaced** a dead path. `listApprovedMessages` without a session has no Honcho v3
endpoint (there is no peer-scoped message list), so it returned `[]` unconditionally and
the old "Memory context (approved brand/policy findings)" block never rendered once in
production. Writing to Honcho without a working read is just a landfill.

## The closed loop

```
performance observation ─┐
strategy approval        ├─► peer-brand / peer-policy ─► deriver ─► representation
denial / rejected angle ─┘                                              │
                                                                        ▼
        strategy prompt  ◄── "Brand memory" block ◄── dialectic /chat query
```

Both halves are gated independently: `HONCHO_WRITE_APPROVALS_ENABLED` (approvals,
denials), `HONCHO_WRITE_PUBLISH_ENABLED` (performance observations),
`ARIES_HONCHO_BRAND_CONTEXT_ENABLED` (the read). All three must be on for the loop to
close.

### Performance observation cadence

Each published post is observed at **24h, 7d and 28d** after publish — trajectory, not a
single snapshot. The `honcho_perf_writes` ledger stores the horizon anchor day
(`publish_day + horizon`) in its `metric_day` column, and the Honcho idempotency key
carries the same anchor, so each horizon writes exactly once and a post is not re-offered
on every one of the ~29 remaining days in its window. Observations are written as **plain
prose** (not JSON) because the deriver builds representations from message content.

#### The claim is two-phase, and why

Performance writes use two tables with different contracts. `memory_write_claim_leases`
holds mutable operational leases; `honcho_write_idempotency_keys` is the append-only
completion ledger and receives a key only **after** the Honcho append succeeds. The worker
ledgers `skipped_idempotent` permanently, so a lease alone is never treated as proof that
the observation exists in Honcho.

`recordPerformanceEvent` atomically distinguishes *completed* (the append-only key exists;
report `skipped_idempotent`), *in flight* (report `failed`, stay due, retry next tick), and
*acquired*. An acquired lease can be new or a one-hour crash orphan taken over atomically.
Caught failures delete only the operational lease. Successful leases remain as a snapshot
interlock while the completion key is retained permanently; no `honcho_*` row is updated or
deleted.

Failure leans toward a duplicate observation, never a dropped one: if the completion insert
itself fails after a good append, the outcome is still `appended` and the worker ledger still
records it.

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
- `session-performance-{jobId}` — post-publish performance observations (prose)

## Local Run Instructions

1. Ensure Honcho is running: `docker ps | grep honcho-api`
2. Verify health: `curl http://localhost:8000/health`
3. Start Aries: `docker compose up aries-app`
4. Trigger a marketing run with a brand URL; the onboarding seed will fire after the dashboard gate if `HONCHO_ENABLED=true` (checked in both the post-login auth journey hook and `maybeSeedOnboardingMemoryForTenant`) and the org has not been seeded yet.

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

Hermes marketing run (weekly_social_content), research + strategy stages
  → loadBrandProfile() [ARIES_HONCHO_BRAND_CONTEXT_ENABLED]
  → dialectic /chat on peer-brand + peer-policy (concurrent, fail-open)
  → "Brand memory" block appended to the stage prompt

Post published, 24h / 7d / 28d later (honcho-performance-worker sidecar)
  → selectDuePerformancePosts() reads insights_posts + insights_post_metrics_daily
  → buildPerformancePayloadRecord() scrubs ids, sanitizes the caption
  → recordPerformanceEvent() appends prose to peer-brand / session-performance-<jobId>
  → deriver folds it into the representation the dialectic query reads next week
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
- **Token budget**: The brand profile block is capped at 1024 tokens; research dispatch context at 4096 (`ARIES_RESEARCH_MEMORY_TOKEN_BUDGET`).
- **Dialectic needs an LLM**: `/chat` is LLM-backed inside `honcho-api`. If its model credential is missing the endpoint 500s, the read fails open, and the block silently never renders. Smoke-test `/chat` before flipping `ARIES_HONCHO_BRAND_CONTEXT_ENABLED`; a failed call logs one `[memory-orchestrator] brand profile dialectic failed` warn line.
- **Thin early profile**: until the deriver has digested a few weeks of observations and approvals, dialectic answers may be near-empty. The read flag defaulting OFF plus a write soak is the mitigation.
- **Observations bypass the curator**: performance prose (including tenant-authored caption excerpts) reaches `peer-brand` without human review. Mitigated by token redaction, platform-id scrubbing, caption sanitisation, and the DATA-ONLY fence at read time — the same posture the prompt-side performance block already takes.
- **Honcho pinned at v3.0.6**: the `/chat` and batched-`/messages` shapes were verified against the running container. The contract lives in `honcho-client.ts` and its tests; a container upgrade should re-verify.
