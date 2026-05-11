# Aries Honcho continuous profile writes (v2)

## Context

The v1 architecture plan (`docs/plans/2026-05-08-aries-hermes-honcho-architecture.md`) is live: `HONCHO_ENABLED=true` in prod, workspace/peer/session/curator infrastructure wired. Writes happen at two events only: onboarding seed (`backend/memory/onboarding-seed.ts`) and post-research-callback curator append (`app/api/internal/aries-research/callback/route.ts:97-113`). The v1 plan already enumerates five additional peer types and three session patterns for day-to-day usage, but none of the write paths that feed them are implemented. Four surfaces in the running app produce durable signal and write nothing to Honcho.

## Goal

Every customer-meaningful event that produces durable signal lands in Honcho via the existing curator pipeline. No new memory schema. No new peer types beyond the seven already enumerated in v1.

## Write surface taxonomy

### Surface 1 — Creative approvals, edits, rejections

Approval flow entry: `app/api/marketing/jobs/[jobId]/approve/handler.ts` calls `approveMarketingJob` or `denyMarketingJob` from `backend/marketing/orchestrator.ts:1996-2024`. Denial carries `deniedBy` and optionally a `note`. Edit/regenerate flow: `backend/marketing/regenerate-creative.ts` (triggered via `app/api/social-content/jobs/[jobId]/creatives/[creativeId]/regenerate/handler.ts`). Upload-replace flow: `backend/marketing/upload-replace.ts` (triggered via `app/api/social-content/jobs/[jobId]/creatives/[creativeId]/upload-replace/handler.ts`).

| Trigger | Peer | Session | Kind | Curator gate | Source file (existing) |
|---|---|---|---|---|---|
| `denyMarketingJob` at strategy or production gate | `peer-brand` (strategy) or `peer-policy` (production/publish) | `session-curated-<jobId>` | `rejected_angle` | Auto-approve if user clicked reject with a reason. Queue otherwise. | `backend/marketing/orchestrator.ts:2012` |
| `denyMarketingJob` at strategy or production gate (audit record) | `peer-approver-<userPseudonym>` | `session-curated-<jobId>` | `fact` | Always auto-approve. Audit-only: body = "user Z denied job J at stage S on date D". | `backend/marketing/orchestrator.ts:2012` |
| `approveMarketingJob` called at strategy gate | `peer-brand` | `session-strategy-<jobId>` | `fact` | Auto-approve if all-first-party, confidence >= 0.85. Queue otherwise. | `backend/marketing/orchestrator.ts:1996` |
| `approveMarketingJob` called at production gate | `peer-policy` | `session-curated-<jobId>` | `constraint` | Auto-approve if first-party, confidence >= 0.85. Queue otherwise. | `backend/marketing/orchestrator.ts:1996` |
| Regenerate-creative submitted | `peer-approver-<userPseudonym>` | `session-curated-<jobId>` | `rejected_angle` | Queue for review. Direction is implicit, not stated. | `backend/marketing/regenerate-creative.ts` |
| Upload-replace promoted (vision QA pass) | `peer-policy` | `session-curated-<jobId>` | `constraint` | Auto-approve if operator_override is false. Queue on override. | `backend/marketing/upload-replace.ts` |

Notes:
- Rejection claims (`kind=rejected_angle`) go to `peer-brand` for strategy-stage denials, or `peer-policy` for production/publish-stage denials. This routes content-bearing denial signal to peers that `HermesMarketingPort.loadMemoryContext` already queries for future research context.
- Every denial is two writes: one content record to `peer-brand`/`peer-policy` and one audit record (`kind=fact`) to `peer-approver-<userPseudonym>`. The audit record body contains only: user pseudonym, job ID, stage name, ISO date.
- `userPseudonym` is derived via `pseudonymForUser(userId)` from `backend/memory/pseudonym.ts`: `HMAC-SHA256(ARIES_TENANT_PSEUDONYM_SALT, 'aries-user:' + userId)`. Reuses `ARIES_TENANT_PSEUDONYM_SALT` with domain separator `'aries-user:'` to distinguish from tenant pseudonyms without requiring a separate env var.
- `denial_reason_code` is a structured enum value (`wrong-tone`, `wrong-colors`, `off-brand`, `factually-wrong`, `legal-concern`, `other`). No free text reaches Honcho from this surface.
- `rejected_angle` findings include the stage and the `denial_reason_code`. If no code is provided, the finding is queued rather than auto-approved.

### Surface 2 — Social publishing, schedule changes, performance data

Publish dispatch: `app/api/publish/dispatch/handler.ts` calls `runAriesWorkflow('publish_dispatch', ...)` and then `runPublishVerification`. Schedule changes: `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts` calls `upsertScheduledPost`. Performance feedback: returned from Hermes stage-4 callbacks via `backend/marketing/hermes-callbacks.ts` when `stage === 'publish'` and `markJobCompleted` is called.

| Trigger | Peer | Session | Kind | Curator gate | Source file (existing) |
|---|---|---|---|---|---|
| `runPublishVerification` returns `verified` | `peer-policy` | `session-curated-<jobId>` | `constraint` | Queue for review. Third-party platform confirmation. | `app/api/publish/dispatch/handler.ts:83` |
| `upsertScheduledPost` succeeds | `peer-policy` | `session-curated-<jobId>` | `constraint` | Auto-approve. Explicit operator action, first-party. | `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:142` |
| Hermes publish callback: `markJobCompleted` with stage `publish` | `peer-market-signal-<topicPseudonym>` | `session-curated-<jobId>` | `research_conclusion` | Queue for review. Performance data is third-party-sourced. | `backend/marketing/hermes-callbacks.ts:188` |

Notes:
- `topicPseudonym` is derived from the campaign's primary competitor or topic tag, falling back to a stable hash of `jobId`.
- Publish-verification writes are high volume. Idempotency key: `(jobId, stage, platform, published_at_date)`. See threat model.
- Performance result claims must contain a source URL from the platform. Claims without a verifiable source URL are dropped by the curator.

### Surface 3 — UI actions and preference signals

Most UI signals are ephemeral. Write only on explicit user intent. Not every click. The allowlist for v1 of this surface:

- Explicit "always use this voice" toggle (if/when added to settings UI).
- Repeated rejection of the same creative direction across more than one job (inferred, requires Phase 3).
- Explicit segment preference saved from audience UI.

Current UI surface examined: `frontend/aries-v1/creative-action-drawer.tsx`. No preference toggles exist yet. The drawer handles upload, regenerate, and override flows only.

| Trigger | Peer | Session | Kind | Curator gate | Source file (existing) |
|---|---|---|---|---|---|
| Operator explicitly saves a creative direction preference (future toggle) | `peer-user-<userPseudonym>` | `session-curated-<jobId>` | `preference` | Auto-approve only if from explicit toggle, never from inferred behavior. | Not yet implemented. Placeholder for Phase 3. |

Note: This surface has no current write path. Phase 3 requires a UI affordance first ("save as my preference" toggle or equivalent). Inferring preference from click patterns is explicitly out of scope for all phases.

### Surface 4 — Pipeline stages 2, 3, 4 (strategy, production, publish/optimize)

Stage completion callbacks arrive at `backend/marketing/hermes-callbacks.ts`. `markJobCompleted` is called when Hermes signals `status: completed` for each stage (`hermes-callbacks.ts:188`). `createApprovalCheckpoint` is called when Hermes signals an approval pause (`hermes-callbacks.ts:202`). The existing `approval-store.ts` persists the approval record (`MarketingApprovalRecord`) before the curator is involved.

| Trigger | Peer | Session | Kind | Curator gate | Source file (existing) |
|---|---|---|---|---|---|
| Hermes strategy callback: user approves via `approveMarketingJob` at `strategy` gate | `peer-brand` | `session-strategy-<jobId>` | `fact` | Auto-approve if all-first-party facts from strategy brief, confidence >= 0.85. Queue otherwise. | `backend/marketing/hermes-callbacks.ts:202`, `backend/marketing/orchestrator.ts:1996` |
| Hermes production callback: user approves at `production` gate | `peer-policy` | `session-curated-<jobId>` | `constraint` | Auto-approve if first-party creative direction approved by user. Queue if any third-party input. | `backend/marketing/hermes-callbacks.ts:202`, `backend/marketing/orchestrator.ts:1996` |
| Hermes publish callback: `markJobCompleted` for `publish` stage with performance output | `peer-market-signal-<topicPseudonym>` | `session-curated-<jobId>` | `research_conclusion` | Queue for review. All performance data is third-party (platform APIs). | `backend/marketing/hermes-callbacks.ts:188` |
| `denyMarketingJob` at strategy gate (content) | `peer-brand` | `session-curated-<jobId>` | `rejected_angle` | Queue unless user supplied explicit reason and clicked deny. | `backend/marketing/orchestrator.ts:2012` |
| `denyMarketingJob` at production/publish gate (content) | `peer-policy` | `session-curated-<jobId>` | `rejected_angle` | Queue unless user supplied explicit reason and clicked deny. | `backend/marketing/orchestrator.ts:2012` |
| `denyMarketingJob` at any gate (audit) | `peer-approver-<userPseudonym>` | `session-curated-<jobId>` | `fact` | Always auto-approve. Body: user pseudonym, job, stage, date only. | `backend/marketing/orchestrator.ts:2012` |

Note: `session-strategy-<jobId>` is already in the v1 session pattern list. It is created only after user approval of the strategy stage, not when the Hermes callback arrives.

## Curator extensions

The existing curator lives at `backend/memory/curator.ts`. Its auto-approve rules (`curator.ts:145-151`) accept `kind` in `{fact, preference, constraint}` with all-first-party sources and confidence >= 0.85. Its queue-for-review rules (`curator.ts:136-143`) cover third-party peers, audience, `research_conclusion`, and `rejected_angle`.

Two rules currently send `rejected_angle` and `preference` to queue unconditionally (`curator.ts:139-140`). These need conditional overrides for the new write surfaces:

**`rejected_angle` from explicit denial:**
- If `approved_by` is a user pseudonym (not `system`) and `claim` contains a non-empty `denial_reason_code` from the denial payload: conditionally auto-approve.
- Otherwise: queue for review (existing behavior).
- `denial_reason_code` is a structured enum (`wrong-tone`, `wrong-colors`, `off-brand`, `factually-wrong`, `legal-concern`, `other`). No free text appears in the claim body. The optional free-text field from the denial form is stored only in `approval-store` (Aries DB) and never written to Honcho.
- Claim body for denials contains: `denial_reason_code`, stage name, job ID. Nothing else.

**`peer-approver` audit writes:**
- `peer-approver-<userPseudonym>` is audit-only. Its `kind=fact` messages record who denied what when, but contain no content signal.
- `HermesMarketingPort.loadMemoryContext` must never return messages from `peer-approver-*` peers. These peers are excluded from context-load queries by convention. Future peers of this type must be documented here before being added.

**`preference` from UI signals:**
- Auto-approve only if `sources[].trust === 'first_party'` and finding metadata contains `explicit_user_intent: true`.
- Never auto-approve if `explicit_user_intent` is absent or false.
- This guards against any inferred behavioral preference leaking through.

**`research_conclusion` from performance data:**
- Always queue for review. No change from current behavior. Explicit here because performance data comes from Hermes and is third-party by definition (`curator.ts:127-128` maps `research_conclusion` to `market_signal` which is a third-party peer).

These changes extend curator logic, not the memory schema. No new peer types, no new session patterns.

## Implementation surface

All Honcho write calls go through a single ingestion module: `backend/memory/write-events.ts`. No write surface in the codebase calls `curateFinding` directly for these events.

Exports:

- `recordApprovalEvent(input)` — strategy/production/publish gate approvals.
- `recordDenialEvent(input)` — explicit denials at any stage. Performs two writes: content record to `peer-brand`/`peer-policy`, audit record to `peer-approver-<userPseudonym>`.
- `recordPublishEvent(input)` — publish-verification verified writes.
- `recordScheduleEvent(input)` — post-schedule writes.
- `recordPerformanceEvent(input)` — Hermes publish-stage callback performance writes.

Each function: validates input, builds the finding (kind, claim, sources, approved_by, supersedes), runs the idempotency check against `honcho_write_idempotency_keys`, then delegates to `curateFinding` from `backend/memory/curator.ts`. All calls are scheduled off the response path (see Write durability in Threat model deltas).

Tests: `tests/memory-write-events.test.ts`.

## Threat model deltas

### Write storms

A user clicking approve/deny in rapid succession (e.g., 50 denials in one session) could produce 50 Honcho writes. Mitigation: idempotency key on each write derived from `sha256(jobId + stage + action + userPseudonym + dateYYYYMMDD)`. If a write with the same key already landed, skip the Honcho call. The approval-store record still persists normally; only the Honcho write is deduplicated.

Idempotency is enforced via a Postgres table: `honcho_write_idempotency_keys (key TEXT PRIMARY KEY, written_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. Before each Honcho write: check whether the key exists. On successful write: insert the key. This table is shared across Phase 1 and Phase 2. Phase 2 key shape: `sha256(jobId + stage + platform + publishedAtDate)`.

### PII leakage via denial reasons

The denial form takes a structured `denial_reason_code` from a fixed enum: `wrong-tone`, `wrong-colors`, `off-brand`, `factually-wrong`, `legal-concern`, `other`. An optional free-text field is available to the operator but is stored only in `approval-store` (Aries DB) and is never written to Honcho. PII therefore never enters the Honcho write path. The structured-reason enum is the entire content channel for denials. No regex scrub is needed on this surface.

### Honcho unavailability blocking user flows

Current policy (v1): silent degradation. All Honcho writes are fire-and-forget behind a `HONCHO_ENABLED` guard. This policy must hold for the new write surfaces. Approval, denial, publish, and schedule actions must complete even if Honcho is unreachable. The write attempt is logged with the error; no exception propagates to the caller. This is the same pattern as `backend/memory/onboarding-memory-hook.ts`.

### Write durability

`write-events.ts` schedules Honcho calls via `setImmediate` (or `void asyncFn()`) with a 2s `AbortSignal` timeout. Returns to caller immediately. Failures and timeouts log via the existing memory-error path and never propagate to the caller.

Trade-off: if Aries restarts (deploy, crash) between the `200 OK` to the user and Honcho ACK, that write is lost. Acceptable because: (a) next research run reads existing brand/policy context and re-establishes signal, (b) approvals are not real-time signal, (c) performance data can be re-pulled from platform APIs.

### Workspace bloat

Phase 1 back-of-envelope (approvals and rejections only):
- Jobs: 50 per year (conservative).
- Sessions per job: 3 (`session-strategy-<jobId>`, `session-curated-<jobId>`, `session-onboarding-<runId>` once).
- Messages per session: 10-20 (approvals, rejections, audit records).
- Phase 1 total per tenant: 50 * 3 * 15 = ~2,250 messages/year.

Phase 2 adds substantial volume:
- Schedule writes: ~250/year (5 posts/job * 50 jobs).
- Publish-verification writes: ~250/year (5 platforms * 50 jobs).
- Performance-callback writes: up to ~7,500/year (daily per published asset: 30 days * 5 platforms * 50 jobs).
- Phase 2 total per tenant: ~10,000-15,000 messages/year. The 10k threshold is crossed in year 1.

Idempotency keys (`honcho_write_idempotency_keys`) are the primary guard against write bloat from duplicate events. Superseded messages are retained for audit per the v1 append-only invariant. If per-tenant message counts exceed 10,000, add a pruning job scoped to superseded-only records older than 18 months. No pruning in v1. Phase 2 ships with a volume load test as the trigger; if real volume exceeds the stated bound, pruning becomes a Phase 2.5 follow-up.

## Rollout phases

Each phase is independently shippable behind its own env gate. All phases share the existing `HONCHO_ENABLED` guard as the outer gate.

### Phase 1 — Strategy approvals and creative rejections

**Scope:** Surface 4 strategy gate + Surface 1 explicit denials. Lowest-risk: explicit user intent, existing approval flows, small write volume.

Write targets:
- `approveMarketingJob` at `strategy` stage: write `kind=fact` to `session-strategy-<jobId>` against `peer-brand`.
- `denyMarketingJob` at any stage: two writes — (1) `kind=rejected_angle` to `session-curated-<jobId>` against `peer-brand` (strategy) or `peer-policy` (production/publish); (2) `kind=fact` audit record to `peer-approver-<userPseudonym>` with body: user pseudonym, job, stage, date.

Idempotency: `honcho_write_idempotency_keys` table. Key = `sha256(jobId + stage + action + userPseudonym + dateYYYYMMDD)`.

Pseudonym extension: `pseudonymForUser(userId)` in `backend/memory/pseudonym.ts` uses `HMAC-SHA256(ARIES_TENANT_PSEUDONYM_SALT, 'aries-user:' + userId)`. No new env var.

Denial form: `denial_reason_code` enum replaces free-text. Optional free-text stored in `approval-store` only, never in Honcho.

Curator extension required: conditional auto-approve for `rejected_angle` with explicit `denial_reason_code`.

All writes via `write-events.ts` off the response path with 2s timeout.

**Env gate:** `HONCHO_WRITE_APPROVALS_ENABLED=true`

**Test plan:**
1. Approve a strategy stage job with `HONCHO_WRITE_APPROVALS_ENABLED=true`. Assert `session-strategy-<jobId>` exists in Honcho with one message, `kind=fact`, `approved_by=<userPseudonym>`.
2. Deny a production job with an explicit `denial_reason_code`. Assert `session-curated-<jobId>` has a `kind=rejected_angle` message with `denial_reason_code` in claim body. Assert a second message exists in `peer-approver-<userPseudonym>` with `kind=fact` (audit). Assert no raw user ID appears in any Honcho field.
3. Deny without a reason code. Assert the finding is queued in `aries_research_findings` with `queue_for_review`. Assert audit record is still written to `peer-approver-<userPseudonym>`.
4. Double-approve same job at same stage: assert exactly one Honcho write (idempotency key deduplication).
5. With `HONCHO_WRITE_APPROVALS_ENABLED=false`: approve and deny. Assert no new Honcho sessions or messages are created.
6. With Honcho unreachable: approve. Assert the approval-store record is written and the API returns 200. No error surfaces to the caller.
7. Honcho slow (3s response time): assert approval API returns within 200ms. Write happens off the response path.

**Rollback:** Set `HONCHO_WRITE_APPROVALS_ENABLED=false`. No data migration needed. Existing Honcho records are append-only and remain inert.

### Phase 2 — Publishing events and performance feedback

**Scope:** Surface 2. Publish verification, schedule changes, Hermes publish-stage callback.

Write targets:
- `runPublishVerification` returns `verified`: write `kind=constraint` to `peer-policy` via curator queue.
- `upsertScheduledPost` succeeds: write `kind=constraint` to `peer-policy`, auto-approve.
- `markJobCompleted` for `publish` stage: write `kind=research_conclusion` to `peer-market-signal-<topicPseudonym>`, queue for review.

Idempotency: key = `sha256(jobId + stage + platform + publishedAtDate)`. Check before write.

PII scrub: performance result claims are sanitized before write. Platform post IDs must not appear in claim bodies.

**Env gate:** `HONCHO_WRITE_PUBLISH_ENABLED=true`

**Test plan:**
1. Dispatch a publish event for `provider=facebook`. Assert `peer-policy` has a new `constraint` message citing the job and platform. Assert it is queued for review (not auto-approved) because publish verification is third-party.
2. Schedule a post. Assert `peer-policy` has a new `constraint` message, auto-approved, with `approved_by=system`.
3. Send duplicate publish dispatch for same job+platform+date. Assert only one Honcho write occurs (idempotency).
4. Inject a platform post ID into the performance result. Assert the scrubber removes it before the claim body reaches the curator.
5. Honcho unreachable: dispatch publish. Assert `runPublishVerification` completes and API returns 202.
6. Volume load test: simulate one month of typical-tenant activity (50 jobs, 5 platforms, daily performance callbacks). Assert total Honcho writes stay under 1,500 per tenant per month. If this bound is breached, pruning becomes a Phase 2.5 follow-up.

**Rollback:** Set `HONCHO_WRITE_PUBLISH_ENABLED=false`. No migration.

### Phase 3 — UI preference signals

**Scope:** Surface 3. Only after explicit UI affordances (preference toggle) are built. This phase cannot ship before those toggles exist.

Write targets:
- Explicit "always use this voice/style" toggle save event: write `kind=preference` to `peer-user-<userPseudonym>`.

Curator extension required: auto-approve only if `explicit_user_intent=true` in finding metadata.

**Env gate:** `HONCHO_WRITE_PREFERENCES_ENABLED=true`

**Test plan:**
1. Trigger explicit preference save (simulated toggle action). Assert `peer-user-<userPseudonym>` has a `preference` message, auto-approved.
2. Simulate inferred click behavior (no explicit toggle). Assert no Honcho write occurs.
3. Trigger preference save with PII-like content in the preference label. Assert scrubber removes it before curator.
4. Trigger preference save with Honcho unreachable. Assert API returns 200, preference saved to Aries DB, no error surfaced.

**Rollback:** Set `HONCHO_WRITE_PREFERENCES_ENABLED=false`. No migration.

## What this plan deliberately does NOT do

- Does not introduce peer types beyond the seven enumerated in the v1 plan.
- Does not write user preference signals inferred from behavioral patterns or click sequences.
- Does not change the curator's append-only / supersedes-not-mutates invariant.
- Does not block user-visible flows (approval, publish, schedule) on Honcho writes.
- Does not make Honcho the canonical record for approval decisions. `approval-store.ts` and the marketing job runtime document remain authoritative.
- Does not write raw Hermes callback output to Honcho. The curator gate applies to all writes.
- Does not require schema changes to `aries_research_findings` or any Honcho message body fields not already defined in v1.

## Verification

Each assertion below is a test case for its phase.

**Phase 1 assertions:**

V0. Idempotency on double-approve.
- Action: user approves the same job at the same stage twice.
- Assert: exactly one Honcho write occurs. Second call inserts no new message. `honcho_write_idempotency_keys` contains exactly one row for the derived key.

V1. Strategy approval write.
- Action: user approves strategy stage for job `J1`.
- Assert: Honcho workspace for tenant contains session `session-strategy-J1`, peer `peer-brand`, one message with `kind=fact`, `approved_by=<userPseudonym>`, `research_job_id=J1`.
- Assert: no real tenant ID or user ID appears in any Honcho field.

V2. Explicit denial write.
- Action: user denies production stage with `denial_reason_code=wrong-colors`.
- Assert: session `session-curated-J1`, peer `peer-policy`, one message with `kind=rejected_angle`, claim contains `denial_reason_code=wrong-colors`, stage, and job ID. No free text. No PII.
- Assert: a second message in `peer-approver-<userPseudonym>`, `kind=fact`, body contains user pseudonym, job, stage, date only.
- Assert: finding auto-approved by curator (explicit reason code present).

V3. Denial without reason code.
- Action: user denies without providing a `denial_reason_code`.
- Assert: `rejected_angle` finding placed in `aries_research_findings` with status `queue_for_review`. Audit record (`kind=fact`) is still written to `peer-approver-<userPseudonym>`.

V4. Gate-off.
- `HONCHO_WRITE_APPROVALS_ENABLED=false`. Approve and deny jobs. Assert no new sessions or messages in Honcho. Assert approval-store records are still written.

V5. Honcho unavailable during approval.
- Honcho returns 503. User approves job.
- Assert: API returns 200. Job advances to next stage. Honcho write failure is logged. No exception thrown to caller.

V6. Write latency does not block caller.
- Honcho response delayed to 3s. User approves job.
- Assert: approval API returns within 200ms. Honcho write completes (or times out) off the response path.

**Phase 2 assertions:**

V7. Publish constraint write.
- Action: dispatch publish event, verification returns `verified`.
- Assert: `peer-policy` has new message `kind=constraint`, queued for review, claim references job and platform.

V8. Schedule constraint write.
- Action: schedule a post.
- Assert: `peer-policy` has new message `kind=constraint`, auto-approved, claim references job and post.

V9. Performance data write.
- Action: Hermes publish-stage callback signals `status=completed` with performance output.
- Assert: `peer-market-signal-<topicPseudonym>` has new message `kind=research_conclusion`, queued for review.

V10. Idempotency.
- Action: dispatch publish for same job + platform + date twice.
- Assert: exactly one Honcho write. Second call is a no-op.

V11. Volume load test.
- Simulate one month of typical-tenant activity: 50 jobs, 5 platforms, daily performance callbacks.
- Assert: total Honcho writes stay under 1,500 per tenant per month.
- If bound is exceeded, pruning becomes Phase 2.5 scope.

**Phase 3 assertions:**

V12. Explicit preference write.
- Action: operator saves explicit voice preference via toggle.
- Assert: `peer-user-<userPseudonym>` has new message `kind=preference`, auto-approved, `explicit_user_intent=true` in metadata.

V13. Inferred behavior rejected.
- Action: operator clicks on a creative without any preference toggle.
- Assert: no Honcho write occurs.

V14. PII scrub on preference label.
- Action: operator saves preference with their name in the label field.
- Assert: name-like token is redacted in the claim body before write. Raw label is not stored in Honcho.

## NOT in scope

- Inferring preference from behavioral patterns (click sequences, dwell time, repeated rejections). Phase 3 requires explicit user intent only.
- Free-text rejection reasons in Honcho. Replaced by the structured enum in 4A. Free text stays in `approval-store` for human review, never reaches the memory layer.
- A separate user pseudonym salt. Domain-separated reuse of `ARIES_TENANT_PSEUDONYM_SALT` covers the need (2A).
- Routing memory writes through Hermes. Hermes is workflow-shaped, wrong tool for 50-byte facts.
- A Postgres outbox for Honcho writes. In-process best-effort (7A) is sufficient until production data justifies the upgrade. Documented as a Phase 4 contingency if monitoring shows >5% lost writes.
- Honcho-side uniqueness constraints for idempotency. Solved Aries-side with `honcho_write_idempotency_keys`. Revisit if Honcho exposes the primitive.
- Pruning superseded messages. Phase 2.5 contingency, triggered by volume load test exceeding stated bound.
- New peer types beyond v1's enumeration.

## What already exists

- `backend/memory/curator.ts` — curator logic. Plan extends with conditional rules for `rejected_angle` (when `approved_by` is a user pseudonym) and `preference` (requires `explicit_user_intent` metadata). No schema change.
- `backend/memory/pseudonym.ts` — `pseudonymForTenant` already in use. `pseudonymForUser` exists but unused; plan updates its domain separator to `'aries-user:'` (clean change, no migration).
- `backend/memory/onboarding-seed.ts` — reference implementation of the existing write pattern. `write-events.ts` mirrors its shape for the new surfaces.
- `backend/marketing/approval-store.ts` — approval/denial records persist here regardless of Honcho state. Plan does not replace it; both stores coexist (Aries DB = canonical, Honcho = curated memory).
- `app/api/internal/aries-research/callback/route.ts` — existing curator write path for research findings. Plan does not modify; only adds parallel write paths via `write-events.ts`.
- `HermesMarketingPort.loadMemoryContext` (`backend/marketing/ports/hermes.ts:212-290`) — existing read path for brand/policy. Once writes land, this picks up new content automatically with no change.

## Failure modes

For each new codepath, one realistic production failure:

- `recordApprovalEvent` — Honcho returns 503 mid-write. **Mitigation:** 7A. Logged, not propagated. Test V5. Status: covered.
- `recordDenialEvent` — User supplies `reason='other'` with no structured info. Audit record still writes (`peer-approver`); content write is `kind=rejected_angle, claim={reason_code: 'other', stage: 'production'}` with no body. **Risk:** future research context gets a row that says "user denied something but we don't know what." **Acceptable** because the count alone is signal; mitigated by encouraging structured reasons in the form.
- `recordPublishEvent` — Idempotency key collision (same job/stage/platform/date but different content). **Risk:** later legitimate write skipped. **Mitigation:** key includes `dateYYYYMMDD` so re-publish on a new day generates a new key. Same-day duplicates are correctly deduped.
- `recordPerformanceEvent` — Hermes callback fires daily for 30 days * 5 platforms = 150 writes/job. Volume risk addressed in 6A. **Status:** load test V11 enforces the bound.
- `userPseudonym` collision with legacy `pseudonymForUser` callers — none exist today (verified). **Status:** clean change.
- `setImmediate` write lost on Aries restart — see 7A trade-off. **Status:** acceptable, monitored via memory-error logs.

**Critical gaps:** None. All paths have either a test, a mitigation, or a documented acceptable-failure rationale.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Pseudonym extension | `backend/memory/pseudonym.ts`, tests | — |
| Idempotency table + migration | `scripts/init-db.js`, new migration | — |
| `write-events.ts` ingestion module | `backend/memory/`, tests | Pseudonym, idempotency |
| Curator extensions | `backend/memory/curator.ts`, tests | — |
| Denial form structured-reason enum | `frontend/aries-v1/`, `app/api/marketing/jobs/[jobId]/`, tests | — |
| Phase 1 call-site integration | `backend/marketing/orchestrator.ts`, tests | All above |

**Lanes:**
- Lane A: Pseudonym → write-events → call-site integration (sequential, shared `backend/memory/`).
- Lane B: Idempotency table + migration (independent).
- Lane C: Curator extensions (independent of A/B).
- Lane D: Denial form structured-reason enum (independent frontend work).

**Execution order:** Launch B + C + D in parallel worktrees. A is sequential within itself. A's last step depends on B and C completing first.

**Conflict flags:** A and C both touch `backend/memory/`; A imports from C's extended curator. Coordinate by landing C before A's final integration step.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 7 issues, 0 critical gaps, 7/7 decisions resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (Phase 3 will need it once preference-toggle UI is designed) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement Phase 1. Design review recommended before Phase 3 (preference-toggle UI).
