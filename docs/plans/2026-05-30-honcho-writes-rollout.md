# Honcho continuous-profile-writes — LAND + flip + verify in prod

**Status:** Open. Rollout/verify plan, not greenfield.
**Author:** Auto-generated 2026-05-30 from the Honcho rollout backlog session.
**Source spec:** `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md` (Phases 1–3 + assertions V0–V14).
**Related landed work:**
- PR #441 `v0.1.8.7 feat(memory): flip Honcho Phases 1+2+3 on in production`
- PR #443 `v0.1.8.8 fix(memory): make Honcho writes actually reach Honcho v3`
- `docs/plans/2026-05-24-honcho-performance-insights-integration.md` (downstream perf-poller)

---

## Context

The v2 continuous-profile-writes spec (`2026-05-11`) defined four write surfaces and three phases, each behind its own env gate under the outer `HONCHO_ENABLED` guard. The backlog (`TODOS.md`) still frames this as "Phase 1 gated on a user decision; Phases 2+3 on branches that need landing." **That framing is stale.** Ground-truth inspection shows all three phases' code is already on `master`, all call-sites are wired, and the `docker-compose.yml` env defaults are already flipped to `true`.

What is actually still open is narrower and entirely operational:

1. **Prod `.env` is missing two Honcho JWTs.** `HONCHO_CONTROL_PLANE_JWT` and `HONCHO_DATA_PLANE_JWT` are absent from the production `.env` (verified). Without them, `HonchoHttpTransport` sends unauthenticated requests; against a JWT-gated Honcho that is a 401/403 that surfaces as `honcho_unauthorized` and the write silently no-ops.
2. **`HONCHO_BASE_URL` points at a local host.** Prod `.env` has `HONCHO_BASE_URL=http://host.docker.internal:8000`, i.e. a dev-loopback target, not the production Honcho data plane.
3. **There is no V0–V14 prod verification harness.** The spec enumerates 15 assertions; unit/fixture coverage exists (`tests/memory-write-events.test.ts` etc.), but nothing exercises the live prod Honcho workspace end-to-end after the secrets land.
4. **One stale branch to reconcile.** `feat/honcho-approval-writes-phase1` (3 commits) is unmerged but its content already landed via the squashed PRs above — it needs confirming-then-closing, not landing.

This plan sequences those four items: confirm-and-close the stale branch, complete the prod secrets, then run a fixture-primary verification harness mapping every assertion to a check.

## Who cares

- **Brendan (operator/tenant):** wants the marketing pipeline to actually accumulate brand/policy/preference memory so future research and creative reflect his approvals and rejections. Today writes are silently no-oping in prod because the transport can't authenticate.
- **Marketing pipeline (read side):** `HermesMarketingPort.loadMemoryContext` already queries `peer-brand`/`peer-policy`; it gets nothing new until writes land for real.
- **On-call / future eng:** needs a documented per-phase kill switch and a verification harness to prove writes land without a full E2E pipeline run.

## Decisions (locked, do not re-litigate)

- **D1. No code changes to the write path.** All five `schedule*HonchoWrite` entry points and `curateFinding` extensions are landed and correct. This plan ships secrets + a verification harness only. (If V-assertions fail, that is a bug ticket, not a re-design.)
- **D2. Silent degradation stays.** Missing/invalid Honcho config must never break approval/publish/schedule/preference flows. This is already the implemented behavior (`isHonchoEnabled()` short-circuit + `setImmediate` off-response-path + swallowed errors). Do not add fail-loud config validation to the request path. `validateHonchoConfig` stays startup-only.
- **D3. Per-phase env gates are the rollback primitive.** `HONCHO_WRITE_APPROVALS_ENABLED`, `HONCHO_WRITE_PUBLISH_ENABLED`, `HONCHO_WRITE_PREFERENCES_ENABLED` each kill one surface without redeploy. No code rollback path needed.
- **D4. Flip order is approvals → publish → preferences.** Even though compose defaults are all `true`, the verification harness validates one gate at a time so a misbehaving surface is isolated. Start with the lowest-volume, explicit-intent surface (approvals).
- **D5. Reuse `ARIES_TENANT_PSEUDONYM_SALT` with `aries-user:` domain separator** for `pseudonymForUser` (already implemented, `backend/memory/pseudonym.ts:38`). No new salt env var.
- **D6. No new peer types, no schema migration.** Idempotency table and findings table already exist in `scripts/init-db.js`.

## Current State (VERIFIED)

| Component | State | Evidence |
|---|---|---|
| Phase 1 writers (`recordApprovalEvent`, `recordDenialEvent`) | landed | `backend/memory/write-events.ts:176,243` |
| Phase 2 writers (`recordPublishEvent`, `recordScheduleEvent`, `recordPerformanceEvent`) | landed | `backend/memory/write-events.ts:482,565,652` |
| Phase 3 writer (`recordCreativeVoicePreferenceEvent`) | landed | `backend/memory/write-events.ts:899` |
| Approval call-site wired | yes | `backend/marketing/orchestrator.ts:2232` (`scheduleMarketingApprovalHonchoWrites`) |
| Publish-verify call-site wired | yes | `app/api/publish/dispatch/handler.ts:79` |
| Schedule call-site wired | yes | `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:219` |
| Perf-callback call-site wired | yes | `backend/marketing/hermes-callbacks.ts:1879,1900` |
| Preference call-site wired | yes | `app/api/social-content/jobs/[jobId]/creative-voice-preference/handler.ts:127` |
| Curator `rejected_angle`/`preference` conditional auto-approve | landed | `backend/memory/curator.ts:71-82,183-208` |
| `pseudonymForUser` domain separator | `aries-user:` | `backend/memory/pseudonym.ts:38` |
| Idempotency table DDL | exists | `scripts/init-db.js:526` (`honcho_write_idempotency_keys`) |
| Preferences table DDL | exists | `scripts/init-db.js:517` (`marketing_operator_creative_preferences`) |
| Findings/queue table | exists | `backend/memory/research-jobs.ts:57` (`aries_research_findings`) |
| compose `HONCHO_*` gate defaults | all `true` | `docker-compose.yml:101-104` |
| Prod `.env` `HONCHO_ENABLED` / approvals / publish | `true` | `.env` |
| Prod `.env` `HONCHO_BASE_URL` | `http://host.docker.internal:8000` (dev loopback) | `.env` — **needs prod data-plane URL** |
| Prod `.env` `HONCHO_CONTROL_PLANE_JWT` | **ABSENT** | `.env` — **gap** |
| Prod `.env` `HONCHO_DATA_PLANE_JWT` | **ABSENT** | `.env` — **gap** |
| Prod `.env` `ARIES_TENANT_PSEUDONYM_SALT` | SET | `.env` |
| Transport bearer selection | control-plane for workspace create/delete, data-plane otherwise; each falls back to the other | `backend/memory/honcho-http-transport.ts:35-40` |
| Stale branch `feat/honcho-approval-writes-phase1` | 3 commits, unmerged, content already on master via #441/#443 | `git log origin/master..origin/feat/honcho-approval-writes-phase1` |
| V0–V14 prod verification harness | **does not exist** | no `scripts/verify-honcho*.mjs` |

**Net:** code is done; the rollout is blocked on (a) two missing JWTs + a prod base URL, (b) a stale branch to close, (c) a verification harness to prove the writes land.

## Architecture (data flow once secrets land)

```
 Operator action (approve / deny / schedule / publish-verify / save-preference)
   │
   ▼
 Route handler / orchestrator  ── responds 200/202 immediately ──▶ Browser
   │   (off the response path)
   ▼ setImmediate(void async)
 schedule*HonchoWrite()  ──▶  record*Event()
   │                              │
   │   isHonchoEnabled() &&       │ claimIdempotencyKey(sha256(...))  ─┐
   │   isHonchoWrite<Gate>()      │   INSERT … ON CONFLICT DO NOTHING  │ Postgres
   │   else: no-op                │   (dedupe; loser short-circuits) ◀─┘ honcho_write_idempotency_keys
   ▼                              ▼
 curateFinding()  ──┬── auto_approve ──▶ TenantMemoryClient.appendApprovedMessage
                    │                         │  HonchoHttpTransport (Bearer JWT)
                    │                         ▼
                    │                   ┌──────────────────────────────┐
                    │                   │  Honcho prod data plane      │
                    │                   │  workspace = tenant pseudonym│
                    │                   │  peer-brand / peer-policy /  │
                    │                   │  peer-approver-* / peer-user-*/
                    │                   │  peer-market-signal-*        │
                    │                   └──────────────────────────────┘
                    └── queue_for_review ─▶ aries_research_findings (Postgres, review queue)
                                              └─▶ GET /api/tenant/research/review-queue
```

Failure isolation: a 401/503 from Honcho throws `MemoryError` inside the `setImmediate` callback, is caught + logged, never reaches the caller. The idempotency key is claimed *before* the Honcho call, so a failed write burns its key — see Rollback / known trade-off.

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|---|---|---|---|
| 0 | Confirm + close stale `feat/honcho-approval-writes-phase1` branch | P1 | 15m / 5m | — |
| 1 | Complete prod Honcho secrets (2 JWTs + prod base URL) | P0 | 30m / n/a (human-only, prod creds) | Honcho prod tenant provisioned |
| 2 | Approvals verification (gate `HONCHO_WRITE_APPROVALS_ENABLED`, V0–V6) | P0 | 1h / 30m | Phase 1 |
| 3 | Publish verification (gate `HONCHO_WRITE_PUBLISH_ENABLED`, V7–V11) | P1 | 1h / 30m | Phase 2 |
| 4 | Preferences verification (gate `HONCHO_WRITE_PREFERENCES_ENABLED`, V12–V14) | P2 | 30m / 20m | Phase 2 |
| 5 | Idempotency-key burn monitor + lost-write log alert | P2 | 45m / 30m | Phase 2 |

---

### Phase 0 — Confirm + close the stale branch

**Implementation**
- `git log origin/master..origin/feat/honcho-approval-writes-phase1 --oneline` shows 3 commits (`c4da722`, `4ab6b11`, `4a432a5`). Diff each file region against `master`: the Phase 1 writers + curator extensions on master already include the Copilot-review fixes (`backend/memory/write-events.ts:81` atomic `claimIdempotencyKey`, `backend/memory/curator.ts:71-78` explicit-denial gate). Confirm no unique hunk remains.
- If `git diff origin/master origin/feat/honcho-approval-writes-phase1 -- backend/ tests/` is empty (modulo already-landed content), delete the remote branch via `gh`/`git push origin --delete`. Do **not** open a PR.

**Acceptance**
- `git diff origin/master origin/feat/honcho-approval-writes-phase1` shows no behavioral delta on the write path.
- Branch deleted (or a one-line note in `TODOS.md` recording it was content-confirmed-merged and closed).

---

### Phase 1 — Complete prod Honcho secrets (human-only)

**Implementation** (operator, on the prod host — never commit secrets):
- Obtain from the Honcho prod tenant: data-plane JWT, control-plane JWT, and the prod data-plane base URL.
- Set in production `.env` (alongside the already-present `ARIES_TENANT_PSEUDONYM_SALT`):
  - `HONCHO_DATA_PLANE_JWT=<data-plane JWT>`
  - `HONCHO_CONTROL_PLANE_JWT=<control-plane JWT>` (used only for workspace create/delete; data-plane is the fallback per `honcho-http-transport.ts:36-39`)
  - `HONCHO_BASE_URL=<prod data-plane URL>` (replace `http://host.docker.internal:8000`)
- `validateHonchoConfig` (startup) already asserts `HONCHO_BASE_URL` present and salt ≥16 chars when `HONCHO_ENABLED=true`; it does **not** assert the JWTs (silent-degradation by design, D2). So a missing JWT will not fail startup — Phase 2's V-checks are what catch it.
- Restart the `aries-app` container so the new env is read.

**Acceptance**
- Startup log shows no `[honcho]` config throw.
- A manual one-shot write smoke (Phase 2 V1) lands a message in the prod Honcho workspace — this is the real proof the JWT + URL are correct, since the config validator stays silent on JWTs.

---

### Phase 2 — Approvals verification (V0–V6)

**Implementation**
- Build `scripts/verify-honcho-writes.mjs` as a tenant-scoped harness with two backends: a **fixture mode** (in-process, injects a fake `HonchoTransport` capturing appended messages — no live Honcho) and a **prod mode** (`--prod`, reads back from the live workspace via a data-plane GET). Fixture mode is the primary, runs in CI; prod mode is the post-flip gate Brendan runs once.
- Approvals checks call `recordApprovalEvent` / `recordDenialEvent` directly with a captured transport and assert against the resulting `appendApprovedMessage` calls and the `aries_research_findings` queue rows (using a test DB pool, or a disposable tenant in prod mode).

**Acceptance — each maps to a spec assertion:**
- **V0** double-approve same job/stage → exactly one `honcho_write_idempotency_keys` row for the derived key; second call no-ops.
- **V1** strategy approve → `session-strategy-<jobId>` + `peer-brand`, one `kind=fact`, `approved_by=<userPseudonym>`; assert no raw tenant/user id in any field (regex the appended message JSON for the raw `userId`).
- **V2** deny `production` w/ `denial_reason_code=wrong-colors` → `peer-policy` `kind=rejected_angle` claim contains the code + stage + job, no free text; second `peer-approver-*` `kind=fact` audit; finding auto-approved.
- **V3** deny w/o reason code → `rejected_angle` lands in `aries_research_findings` `queue_for_review`; audit `kind=fact` still written.
- **V4** gate off (`HONCHO_WRITE_APPROVALS_ENABLED=false`) → approve+deny produce zero appended messages; approval-store record still written.
- **V5** Honcho 503 (fixture transport throws `MemoryError`) → caller path returns normally, error logged, no throw.
- **V6** Honcho 3s latency (fixture transport delays) → the `schedule*` caller returns synchronously (write is on `setImmediate`); assert the schedule call itself does not await.

---

### Phase 3 — Publish verification (V7–V11)

**Implementation** — same harness, `--surface=publish`. Exercises `recordPublishEvent`, `recordScheduleEvent`, `recordPerformanceEvent` with captured transport + test pool.

**Acceptance:**
- **V7** publish-verify `verified` → `peer-policy` `kind=constraint`, `queue_for_review` (third-party source). Verify it lands in `aries_research_findings`, not Honcho-appended.
- **V8** schedule post → `peer-policy` `kind=constraint`, auto-approved, `approved_by=system` (first-party).
- **V9** Hermes publish-stage callback with `https` `source_url` → `peer-market-signal-<topicHex>` `kind=research_conclusion`, queued. Assert payload ran through `scrubPlatformIdsFromPerformancePayload` (inject `platform_post_id` + a 15-digit numeric string → both stripped/redacted).
- **V10** duplicate publish for same job+platform+date → one idempotency row, second is no-op.
- **V11** volume bound: simulate 50 jobs × 5 platforms × daily callbacks for a month, count `claimIdempotencyKey` wins → assert < 1,500 writes/tenant/month. If exceeded, file Phase 2.5 pruning ticket (does not block flip).

---

### Phase 4 — Preferences verification (V12–V14)

**Implementation** — `--surface=preferences`, exercises `recordCreativeVoicePreferenceEvent`.

**Acceptance:**
- **V12** explicit toggle save → `peer-user-<userPseudonym>` `kind=preference`, auto-approved, `metadata.explicit_user_intent=true`.
- **V13** `explicitUserIntent=false` → zero appended messages (writer short-circuits at `write-events.ts:905`).
- **V14** label with a `<First Last>` name → `scrubPreferenceLabelForHoncho` redacts before claim. Run with `ARIES_MEMORY_LABEL_REDACTION_V2=1` (prod default per `docker-compose.yml:78`) and assert "Bold Minimalist" survives while "John Smith" → `[redacted_name]`; also assert email → `[redacted_email]`.

---

### Phase 5 — Idempotency-key burn monitor (operational hardening)

**Implementation**
- The known trade-off: `claimIdempotencyKey` inserts the key *before* the Honcho append, so a Honcho failure burns the key and the write is never retried (acceptable per spec §Write durability). Add a lightweight check: a periodic query (or a one-shot script) comparing distinct `honcho_write_idempotency_keys` rows against successful appends inferred from the memory-error log rate. If >5% of attempts log a `MemoryError`, that is the Phase 4 outbox contingency trigger from the source plan's NOT-in-scope list.

**Acceptance**
- A grep-able log line `[honcho-write-events] … failed` count is surfaced (existing `console.error` lines suffice); document the threshold (5% lost-write rate → escalate to outbox) in `TODOS.md`. No new infra.

---

## Testing Plan

Fixture-primary: every V-assertion has an in-process fixture check (injected `HonchoTransport`, test DB pool) that runs in CI. Prod-mode (`--prod`) re-runs the read-back assertions against the live workspace once per flip, run by the operator.

| Assertion | Surface | Fixture check | Prod read-back | Existing coverage |
|---|---|---|---|---|
| V0 idempotency (approve) | approvals | yes | row count | `tests/memory-write-events.test.ts` |
| V1 strategy approve | approvals | yes | GET session/peer | `tests/memory-write-events.test.ts` |
| V2 explicit deny | approvals | yes | GET both peers | `tests/memory-write-events.test.ts` |
| V3 deny no-reason → queue | approvals | yes | `review-queue` row | `tests/memory-write-events.test.ts` |
| V4 gate off | approvals | yes | n/a | `tests/memory-honcho-env.test.ts` |
| V5 Honcho 503 | approvals | yes (throwing transport) | n/a | — (add) |
| V6 latency non-blocking | approvals | yes (delayed transport) | n/a | — (add) |
| V7 publish constraint | publish | yes | `review-queue` row | `tests/publish-verification.test.ts` |
| V8 schedule constraint | publish | yes | GET peer-policy | `tests/memory-write-events.test.ts` |
| V9 perf scrub + queue | publish | yes (inject platform_post_id) | `review-queue` row | `tests/memory-write-events.test.ts` |
| V10 idempotency (publish) | publish | yes | row count | `tests/memory-write-events.test.ts` |
| V11 volume bound | publish | yes (simulated month) | n/a | — (add to harness) |
| V12 explicit pref | preferences | yes | GET peer-user | `tests/memory-write-events.test.ts` |
| V13 inferred rejected | preferences | yes | n/a | `tests/memory-write-events.test.ts` |
| V14 label scrub | preferences | yes | GET peer-user claim | `tests/memory-label-redaction.test.ts` |

Run gate before flip: `npm run verify` then `APP_BASE_URL=https://aries.example.com tsx --test tests/memory-write-events.test.ts tests/memory-label-redaction.test.ts tests/publish-verification.test.ts tests/memory-honcho-*.test.ts`.

## Rollback

- **Per-surface:** set the offending gate to `false` (`HONCHO_WRITE_APPROVALS_ENABLED` / `_PUBLISH_` / `_PREFERENCES_`) and restart `aries-app`. No data migration; existing Honcho records are append-only and inert.
- **Whole feature:** `HONCHO_ENABLED=false`. All `schedule*` calls short-circuit.
- **Secrets backout:** blank `HONCHO_DATA_PLANE_JWT` / `HONCHO_CONTROL_PLANE_JWT` — writes fail-closed silently (D2), caller flows unaffected.
- **Known trade-off (do not "fix" without the outbox decision):** a write that fails after the idempotency key is claimed is lost and not retried. Acceptable per source-plan §Write durability; escalation threshold is Phase 5's >5% lost-write rate.

## Out of Scope

- Any change to the write-path code, curator rules, or schema (D1, D6).
- The Meta `/insights` performance poller that *feeds* `recordPerformanceEvent` — that is `docs/plans/2026-05-24-honcho-performance-insights-integration.md`, a separate workstream. This plan only verifies the write function, not the data source.
- A Postgres outbox for lost writes (source-plan Phase 4 contingency).
- Pruning superseded messages (source-plan Phase 2.5 contingency, triggered by V11).
- New peer types or session patterns.
- Server-side JWT minting (cross-repo, Honcho-side).

## Files Reference

| File | Role |
|---|---|
| `backend/memory/write-events.ts` | All five writers + `schedule*` wrappers + scrubbers (landed) |
| `backend/memory/curator.ts` | `curateFinding` + `rejected_angle`/`preference` conditional auto-approve |
| `backend/memory/honcho-env.ts` | `isHonchoEnabled` + three write-gate readers + `validateHonchoConfig` |
| `backend/memory/honcho-http-transport.ts` | JWT bearer selection (control vs data plane) |
| `backend/memory/pseudonym.ts` | `pseudonymForUser` (`aries-user:` domain separator, L38) |
| `backend/memory/research-jobs.ts` | `aries_research_findings` queue (L57) + `ensureMarketingMemoryQueueJob` |
| `backend/marketing/orchestrator.ts` | approval mirror call-site (L2232) |
| `app/api/publish/dispatch/handler.ts` | publish-verify call-site (L79) |
| `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts` | schedule call-site (L219) |
| `backend/marketing/hermes-callbacks.ts` | perf-callback call-sites (L1879, L1900) |
| `app/api/social-content/jobs/[jobId]/creative-voice-preference/handler.ts` | preference call-site (L127) |
| `app/api/tenant/research/review-queue/route.ts` | review-queue read endpoint (queued findings) |
| `scripts/init-db.js` | idempotency table (L526) + preferences table (L517) |
| `docker-compose.yml` | `HONCHO_*` env gates (L101-104), all defaulting `true` |
| `tests/memory-write-events.test.ts` | primary fixture coverage for all surfaces |
| `tests/memory-label-redaction.test.ts` | V14 scrub coverage |
| `tests/publish-verification.test.ts` | V7 publish coverage |
| `scripts/verify-honcho-writes.mjs` | **new** — V0–V14 harness (fixture + `--prod`) |
| `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md` | source spec (V0–V14 definitions) |
