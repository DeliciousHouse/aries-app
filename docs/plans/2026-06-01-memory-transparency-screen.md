# "What Aries knows about your business" — operator memory transparency screen

> Status: draft plan (2026-06-01). Roadmap area [4], priority 4 (build-first list #6). Phase P2 (first-user experience). This is a **read + manage** operator surface over memory that **already lands** (Honcho writes are live per project memory; queued findings persist in `aries_research_findings`). It is NOT a memory-write feature and NOT autonomous. Ships behind `ARIES_MEMORY_SCREEN_ENABLED` (default OFF).

## Context

Aries curates a tenant-scoped memory (brand facts, audience facts, voice preferences, rejected creative directions, approved publishing constraints, performance learnings) and queues lower-confidence candidates for human review. That curation runs server-side in `backend/memory/curator.ts`; auto-approved facts append to Honcho via **three** append paths (`backend/memory/orchestrator.ts:appendCuratedFinding`, `backend/memory/write-events.ts`, `backend/memory/onboarding-seed.ts`) → `backend/memory/honcho-client.ts`; queued candidates land in `aries_research_findings` (`backend/memory/research-jobs.ts`). The customer can see **none of this**.

The only "memory" screen today, `app/creative-memory/page.tsx`, is internal prompt-recipe tooling — it inspects the *retrieval recipe* for one content brief (baseline vs memory-assisted prompt), is not linked from operator nav (`frontend/app-shell/routes.ts` has no entry for it), and exposes nothing about the durable facts Aries holds. The closest read path, `app/api/tenant/research/review-queue/route.ts`, returns a raw `tenant_admin`-only JSON list of queued findings with no UI.

This plan builds the operator-facing **"What Aries knows about your business"** screen at `/dashboard/memory`: seven sections (brand facts, audience facts, voice preferences, rejected creative directions, approved publishing constraints, performance learnings, pending memory candidates), each fact showing **source, status, used-in**, with **Edit / Supersede / Delete** actions and an **Approve / Reject** action for pending candidates. It is the trust counterpart to the Review Queue: "here is the durable context every weekly plan is built on, and you control it."

Framing (roadmap area 1): *Aries is safety-first and traceable — you can see, correct, and remove anything it remembers.* Nothing on this screen publishes; it only reads and manages memory state.

## Who cares

- **Operators / the @sugarandleather tenant** — they need to trust that the weekly plan is grounded in *correct* facts, and to fix a wrong fact (e.g. a misremembered audience) before it poisons six weeks of content.
- **Product / public-readiness** — "What does the AI actually know about me, and can I edit it?" is a top trust question; an inspectable, correctable memory is a differentiator vs black-box AI marketing tools.
- **Eng** — the curation engine and queued-findings store already exist but have no surface; shipping the read+manage screen closes the loop the PRD (§16.6, §17 Future #7) flagged as open ("tenant admin tools for memory review, supersession, redaction, and export").

## Decisions (locked — do not re-litigate)

1. **DB is the read source of truth, not a peer-scoped Honcho read.** `honcho-client.ts:listApprovedMessages` **returns `[]` for any peer-only call** (no session) on Honcho v3 — there is no peer-scoped enumeration endpoint (see the warn at `honcho-client.ts:182-188`). Therefore the screen MUST NOT try to enumerate durable memory by peer from Honcho. It reads from Postgres: queued candidates from `aries_research_findings`, approved facts from a new append-only `aries_memory_facts` projection table written **at every moment an approved fact is appended to Honcho** (auto-approve in any of the three append paths, or an operator approval). This avoids re-architecting Honcho reads and keeps the screen fast and tenant-scoped.
2. **Append-only + supersede, never hard-mutate.** Edit = write a new fact row that `supersedes` the prior `id` (matching the existing `ApprovedMessage.supersedes` contract, `backend/memory/types.ts:48`). Delete = soft-delete (set `status='deleted'`, retain row for audit). This mirrors the curator's existing supersession model and preserves traceability (CLAUDE.md resumability/audit ethos).
3. **Read-only by default; manage actions gated by role.** Viewing is allowed for any authenticated tenant member. Edit/Supersede/Delete/Approve/Reject require `tenant_admin` (consistent with `app/api/tenant/research/review-queue/route.ts:18` and `app/api/business/profile/route.ts:144` PATCH gating). `tenant_analyst`/`tenant_viewer` see the screen read-only with disabled actions + an explanatory tooltip.
4. **Approving a pending candidate writes to Honcho through the existing orchestrator path, not a new write path.** Approval calls the existing `honcho-client.appendApprovedMessage` (via the orchestrator) AND inserts the projection row — one transaction boundary, idempotent by finding id. No new Honcho client methods.
5. **No new memory the AI did not already produce.** The screen surfaces existing curated/queued facts only. It does not let an operator type free-form facts into memory (that is a larger onboarding/wizard concern, roadmap area 6). Edit only refines the *claim text/status* of a fact Aries already holds.
6. **Flag gates the whole surface.** `ARIES_MEMORY_SCREEN_ENABLED` (default OFF): when OFF, the nav entry is hidden, the page returns the standard not-found/redirect, and the API routes 404. A rollout switch over a complete feature, not a half-built one.
7. **Brand URL discipline.** Any CTA/help copy referencing the live app uses `aries.sugarandleather.com`, never bare `sugarandleather.com`.

## Current State (VERIFIED — branch `fix/story-composer-serving`)

**Curation + memory backend (reused, not rebuilt):**
- `backend/memory/curator.ts` — `curateFinding()` returns `auto_approve | queue_for_review | drop`. Peer mapping (`mapPeer`, lines 165-173): `fact→brand`, `preference→user`, `constraint→policy`, `rejected_angle→policy`, `research_conclusion→market_signal`. **`mapPeer` NEVER returns `audience`** — an `audience` peer only arises when a finding carries an explicit `peerHint:'audience'` (and `shouldQueueForReview` forces `audience` to queue). This is the canonical taxonomy the seven UI sections map onto.
- `backend/memory/types.ts` — `FindingKind = fact|preference|constraint|rejected_angle|research_conclusion`; `PeerKind = brand|policy|user|approver|competitor|audience|market_signal`; `ApprovedMessage` carries `supersedes: string | null` (line 48), `approved_by`, `approved_at`, `research_job_id`, `sources`.
- `backend/memory/research-jobs.ts` — `aries_research_jobs` + `aries_research_findings` tables (`ensureResearchJobSchema`, lines 39-77); `listQueuedResearchFindingsForTenant(tenantId, {limit})` (lines 224-263) returns `queue_for_review` rows joined to job status — **this is the pending-candidates read, already written and tenant-scoped.** `recordFinding` (161-177) is the write (records EVERY decision, incl. `auto_approve`, but only when called — see the gap below). `ensureMarketingMemoryQueueJob` (95-117) attaches marketing-approval-derived queued findings to a deterministic synthetic job.
- `backend/memory/orchestrator.ts` — `createMemoryOrchestrator(client)` returns a closure `appendCuratedFinding` (88-116) that curates then appends auto-approved findings to Honcho via `client.appendApprovedMessage` (108-113). **Critical limitation:** `peerRefForKind` (41-45) only maps peers `brand`/`policy`; for any other auto-approve peer (`user`, `approver`) the orchestrator returns `queue_for_review` with reason `peer_requires_user_id` and does NOT append. So through THIS path only `brand`/`policy` facts ever reach Honcho. `loadResearchMemoryContext` (48-86) is the *read-for-generation* path (peer + token budget).
- `backend/memory/honcho-client.ts` — `appendApprovedMessage` (136-168, batched v3 write, live), `listApprovedMessages` (170-212): **session-scoped reads work; peer-only reads no-op and return `[]`** (the warn at 182-188). Supersession is computed at read time from `metadata.supersedes` / `messageKey` (199-211).
- `backend/memory/honcho-env.ts` — `isHonchoEnabled`, `isHonchoWriteApprovalsEnabled`, `isHonchoWritePreferencesEnabled`, `isHonchoWritePublishEnabled`: the `1|true|yes|on` truthiness pattern this plan's flag copies.

**The three Honcho append paths (VERIFIED — all must write the projection):**
- `backend/memory/orchestrator.ts:108` — `appendCuratedFinding`. Called from `app/api/internal/aries-research/callback/route.ts:99`, which ALSO calls `recordFinding` (line 104) for every outcome — so callback-originated auto-approves ARE in `aries_research_findings`.
- `backend/memory/write-events.ts:132` — `appendHonchoApproved` (creative voice prefs, approval/denial mirror, publish/performance). **On the `auto_approve` branch it calls `appendHonchoApproved` but NOT `recordFinding` — `persistQueuedFinding` is only on the `queue_for_review` branch (lines 230/303/337/522/617/701/969).** So write-events auto-approves are appended to Honcho but are NOT in `aries_research_findings`. `peerRefForAutoApprove` here DOES handle peer `user` (via `preferenceActorUserId`), so this is the only path that actually persists voice-preference (`user`-peer) approvals to Honcho.
- `backend/memory/onboarding-seed.ts:54` — onboarding seed. Appends approved `brand`/`policy` facts to Honcho but **never calls `recordFinding`** — onboarding auto-approves are NOT in `aries_research_findings` either.

**Existing surfaces (reused as wiring precedent):**
- `app/api/tenant/research/review-queue/route.ts` — `tenant_admin`-only GET over `listQueuedResearchFindingsForTenant`. **The pending-candidates read endpoint already exists**; the new screen extends/wraps this shape, it does not reinvent it.
- `app/creative-memory/page.tsx` — internal prompt-recipe tool (NOT this screen; stays where it is, unlinked).
- `app/dashboard/results/page.tsx` — the exact short page pattern (`AppShellLayout currentRouteId=... loginRedirectPath=...` wrapping a `frontend/aries-v1/*` screen) the new page copies.
- `frontend/aries-v1/review-queue.tsx` — the data-driven screen pattern (hook → `ShellPanel`/`EmptyStatePanel`/`StatusChip`/`LoadingStateGrid` primitives from `./components`, `customerSafeUiErrorMessage` from `./customer-safe-copy`) the new screen reuses.
- `frontend/app-shell/routes.ts` — `AppRouteId` union + `APP_ROUTES` array; **no `memory` entry today.** `components/redesign/layout/app-shell-client.tsx` — `ICONS: Record<AppRouteId, …>` (32-47), `SidebarItem` union (49-51), `utilityItems` array (98-107) where a new nav link is added; `reviewCount` badge plumbing (app-shell.tsx 141/145/173) is the precedent for a pending-candidate badge.

**Live-data reality check (VERIFIED against the prod DB, `aries_auth`):**
- `aries_research_findings` currently holds **exactly one row** — `curator_decision='queue_for_review'`, peer `brand`, on the test tenant `tenant-social-approve`. **There are ZERO `auto_approve` rows.**
- `aries_research_jobs` has **14 jobs for tenant_id `15`** (the live @sugarandleather tenant) but **zero persisted findings for tenant 15.**
- Consequence: a backfill that reads only `aries_research_findings WHERE curator_decision='auto_approve'` inserts **zero** rows. Real approved facts for tenant 15 (if any) live only in Honcho, written by the onboarding-seed / write-events paths that never touched the findings table — and Honcho cannot be peer-enumerated. **The screen will render empty for tenant 15 unless approved facts are first produced/seeded.** This is reflected in the revised acceptance bar and rollout (Phases A and E).

**Gaps (what is NEW):**
- No `aries_memory_facts` projection table — approved durable facts are only in Honcho, which cannot be enumerated by peer. Decision 1 fixes this with a write-time projection at all three append sites.
- No operator read endpoint that returns *approved* facts grouped into the 7 sections (only the queued-candidate endpoint exists).
- No Edit/Supersede/Delete/Approve/Reject endpoints for memory facts.
- No `/dashboard/memory` page, no `frontend/aries-v1/memory-screen.tsx`, no nav entry, no `memory` route id.
- No "used-in" linkage surfaced (the data exists — `research_job_id` on facts, marketing job ids on queued findings — but is not projected to the UI).

## Architecture (target data flow)

```
Curation (existing)                          Operator screen (NEW)
─────────────────────                        ─────────────────────
curator.curateFinding()                      GET /api/tenant/memory/facts
  ├─ auto_approve ─> ALL 3 append paths        → reads aries_memory_facts (approved/superseded/deleted)
  │   (orchestrator / write-events /             grouped into 7 sections by (kind, peer)
  │    onboarding-seed)                         → reads aries_research_findings (pending) [REUSE]
  │     ├─ Honcho appendApprovedMessage        → returns { sections[], pendingCandidates[], counts }
  │     └─ NEW: INSERT aries_memory_facts                 │
  │            status='approved'                          ▼
  └─ queue_for_review ─> recordFinding         frontend/aries-v1/memory-screen.tsx
        aries_research_findings (existing)        7 section cards, each fact row:
                                                  source · status · used-in · [Edit][Supersede][Delete]
Operator actions (NEW, tenant_admin)              pending card: [Approve][Reject]
─────────────────────                                       ▲
POST /api/tenant/memory/facts/:id/supersede      (gated by ARIES_MEMORY_SCREEN_ENABLED + role)
  → INSERT new fact, set supersedes=:id
DELETE /api/tenant/memory/facts/:id
  → UPDATE status='deleted' (soft)
POST /api/tenant/memory/candidates/:id/approve
  → Honcho appendApprovedMessage + INSERT aries_memory_facts(status='approved') + mark finding consumed
POST /api/tenant/memory/candidates/:id/reject
  → UPDATE aries_research_findings curator_decision='rejected_by_operator'
```

`aries_memory_facts` is a **projection / index**, not a competing source of truth for generation — `loadResearchMemoryContext` still reads Honcho for weekly planning. The table exists so the operator screen can *enumerate and manage* what Honcho cannot enumerate by peer.

## Phases

| # | Phase | Priority | Effort (human / CC) | Depends on |
|---|-------|----------|---------------------|------------|
| A | Projection table + write-on-approve (all 3 paths) + backfill | Critical | 4h / 1.5h | none |
| B | Read endpoint: approved facts (7 sections) + pending candidates | High | 3h / 1h | A |
| C | Manage endpoints: supersede / delete / approve / reject | High | 4h / 1.5h | A, B |
| D | Operator screen `frontend/aries-v1/memory-screen.tsx` + page + nav | High | 5h / 2h | B, C |
| E | Flag, docs, tests, seed-or-produce real facts + live verify on tenant 15, ship | Medium | 4h / 1.5h | A-D |

**Sequencing:** A first (everything reads the projection). B before C/D (C mutates rows B returns; D renders B). C and D can overlap once B's contract is fixed. E last (needs the full stack to verify rendered UI on the live tenant).

```
A ─> B ─┬─> C ──┐
        └─> D ──┼─> E
```

---

### A — Projection table + write-on-approve (all 3 paths) + backfill (Critical, 4h)

**New table** (migration `migrations/20260601120000_memory_facts.sql`, idempotent):
```sql
CREATE TABLE IF NOT EXISTS aries_memory_facts (
  id            UUID PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,                       -- FindingKind
  peer          TEXT NOT NULL,                       -- PeerKind (section routing)
  claim         TEXT NOT NULL,
  sources       JSONB NOT NULL DEFAULT '[]',
  confidence    DOUBLE PRECISION,
  status        TEXT NOT NULL DEFAULT 'approved'     -- approved | superseded | deleted
                  CHECK (status IN ('approved','superseded','deleted')),
  supersedes    UUID,                                -- prior fact id this replaces
  approved_by   TEXT,
  research_job_id TEXT,                              -- "used-in" linkage
  honcho_message_id TEXT,                            -- best-effort back-ref
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aries_memory_facts_tenant_status
  ON aries_memory_facts(tenant_id, status);
```
Mirror the `CREATE TABLE` in `scripts/init-db.js` for fresh installs (precedent: `ensureResearchJobSchema` style), and add an `ensureMemoryFactsSchema(client)` helper alongside `ensureResearchJobSchema` in a new `backend/memory/memory-facts.ts` (timestamp prefix `20260601120000` sorts after the existing latest migration `20260531120000_posts_surface.sql`).

**`backend/memory/memory-facts.ts` (NEW):**
- `ensureMemoryFactsSchema(client)` — `CREATE TABLE IF NOT EXISTS` guard (callable from each route, matching `ensureResearchJobSchema` usage).
- `insertApprovedFact(ctx, { kind, peer, claim, sources, confidence, approvedBy, researchJobId, honchoMessageId, supersedes })` — INSERT with `status='approved'`; when `supersedes` set, also `UPDATE … SET status='superseded', updated_at=NOW() WHERE id=supersedes AND tenant_id=ctx.tenantId`. Idempotent on a deterministic id derived from `(tenant_id, research_job_id, claim)` hash so a replay of the same auto-approve does not duplicate.
- `listApprovedFactsForTenant(tenantId)` / `softDeleteFact(tenantId, id)` / `supersedeFact(tenantId, id, newClaim, actor)`.
- `groupFactsIntoSections(facts)` — pure helper (see Phase B), unit-testable without DB.

**Write-on-approve hook — at ALL THREE append sites (this is the corrected scope):** the projection must be written wherever an approved fact reaches Honcho, because verification confirmed three independent append paths and two of them never touch `aries_research_findings`:
1. `backend/memory/orchestrator.ts:appendCuratedFinding` — after the successful `appendApprovedMessage` (lines 108-113), call `insertApprovedFact(ctx, …)` with `outcome.approved` + returned `messageId`. (Covers `brand`/`policy` callback auto-approves.)
2. `backend/memory/write-events.ts:appendHonchoApproved` (line 124-138, called from the `auto_approve` branches at 220/295/329/527/607/959) — after the append, call `insertApprovedFact(...)`. **This is the path that captures voice-preference (`user`-peer) and approval/denial/publish/performance auto-approves**, none of which the orchestrator hook would ever see. Thread tenant ctx through `appendHonchoApproved` so the projection insert is tenant-scoped.
3. `backend/memory/onboarding-seed.ts:seedOnboardingMemory` (line 54) — after the append, call `insertApprovedFact(...)` for each approved `brand`/`policy` seed fact.

Each projection write is a **strict add**, wrapped in try/catch + warn so it NEVER throws into the existing append path (mirroring how the codebase treats best-effort memory writes), and is a single-row write (no pool fan-out, guardrail #1). These three additive, failure-isolated calls are the only changes to hot paths.

**Backfill script** `scripts/backfill-memory-facts.mjs` (precedent: `scripts/backfill-creative-asset-ids.mjs`). Source coverage MUST match the three append paths, because the findings table alone is incomplete (verified: zero auto-approve rows; onboarding + write-events approves never landed there):
- `aries_research_findings WHERE curator_decision='auto_approve'` (callback path — currently empty, but the source-of-record going forward).
- **Honcho-backfill fallback:** because onboarding-seed and write-events historical approves exist only in Honcho and cannot be peer-enumerated, the backfill canNOT recover them blind. The script therefore (a) backfills everything recoverable from the findings table, and (b) for tenants where the projection is empty after step (a), logs an explicit "no recoverable approved facts in DB; Honcho-only history is not enumerable — screen will render empty until new approvals land" warning rather than silently implying success. (Do not over-claim a backfill that has no source.)
- Idempotent (`ON CONFLICT DO NOTHING` on the deterministic id). Honcho is not re-read (it cannot be enumerated by peer); the DB findings table is the only backfill source.

**Files touched:** `migrations/20260601120000_memory_facts.sql` (NEW), `scripts/init-db.js`, `backend/memory/memory-facts.ts` (NEW), `backend/memory/orchestrator.ts:108-113`, `backend/memory/write-events.ts` (`appendHonchoApproved` + thread ctx), `backend/memory/onboarding-seed.ts:54`, `backend/memory/index.ts` (export new helpers + types), `scripts/backfill-memory-facts.mjs` (NEW).

**Acceptance (this phase, non-UI):** migration applies idempotently against the live DB; a new auto-approve through **each** of the three paths writes one `aries_memory_facts` row with correct `kind`/`peer`/`status='approved'`; the backfill on tenant 15 inserts whatever the findings table holds (verified: currently zero — so the honest expectation is zero rows until new approvals or a seed run, see Phase E) and a second run is a no-op.

### B — Read endpoint: 7 sections + pending candidates (High, 3h)

**`app/api/tenant/memory/facts/route.ts` (NEW), GET:**
- Resolve `getTenantContext()`; require `ARIES_MEMORY_SCREEN_ENABLED` (else 404). Any authenticated member may read (no role gate on GET).
- `ensureMemoryFactsSchema` + `ensureResearchJobSchema`.
- Read approved facts via `listApprovedFactsForTenant(tenantId)` (exclude `deleted`; include `superseded` flagged but de-emphasized).
- Read pending candidates via the **existing** `listQueuedResearchFindingsForTenant(tenantId, {limit})`.
- Group into the 7 UI sections by `(kind, peer)` via `groupFactsIntoSections`:
  - **Brand facts** = `kind:'fact'` peer `brand`/`approver`
  - **Audience facts** = peer `audience` (only via `peerHint`) OR `kind:'research_conclusion'` audience-tagged — note `mapPeer` never auto-routes `audience`, so this section is fed by `peerHint`/tagging, not the default mapping
  - **Voice preferences** = `kind:'preference'` peer `user` (sourced from the write-events append path — the orchestrator hook alone never produces these)
  - **Rejected creative directions** = `kind:'rejected_angle'`
  - **Approved publishing constraints** = `kind:'constraint'` peer `policy`
  - **Performance learnings** = `kind:'research_conclusion'` peer `market_signal`
  - **Pending memory candidates** = all `queue_for_review` findings (cross-section, shown last)
- Each fact row returns `{ id, claim, kind, peer, status, sources: [{url, trust, fetched_at}], confidence, usedIn: research_job_id, approvedBy, createdAt, supersedes }`. **Never leak raw DB rows or file paths** (CLAUDE.md route-boundary rule) — map to a typed frontend-safe shape.
- Return `{ sections: {...}, pendingCandidates: [...], counts: { pending, approved } }`.

**Files touched:** `app/api/tenant/memory/facts/route.ts` (NEW), `backend/memory/memory-facts.ts` (`groupFactsIntoSections` pure helper, unit-testable without DB).

**Acceptance (non-UI):** `curl` (authed) returns the 7-section payload for tenant 15; pending candidates mirror the existing review-queue endpoint count; superseded/deleted facts are excluded from the active lists. (Brand facts may be empty for tenant 15 until real approvals/seed land — see Phase E; an empty-but-correct grouping is a PASS for this phase.)

### C — Manage endpoints: supersede / delete / approve / reject (High, 4h)

All require `ARIES_MEMORY_SCREEN_ENABLED` + `tenant_admin` (403 otherwise, matching `review-queue/route.ts:18` and `business/profile/route.ts:144`). All tenant-scope every query by `ctx.tenantId` (no client-supplied tenant id).

- **`POST /api/tenant/memory/facts/[id]/supersede`** — body `{ claim }`. Validates the prior fact belongs to the tenant + is `approved`. Inserts a new approved fact (same `kind`/`peer`/`sources`/`research_job_id`) with `supersedes=id`, sets prior to `superseded`. Optionally appends the corrected claim to Honcho via `appendApprovedMessage` with `message.supersedes` set (best-effort, warn-on-fail). "Edit" in the UI is this endpoint.
- **`DELETE /api/tenant/memory/facts/[id]`** — soft delete: `UPDATE … status='deleted'`. Honcho is append-only and cannot delete a single message in v3; document this honestly in the UI ("removed from active memory; Aries will stop using it"). The projection `status='deleted'` is what `loadResearchMemoryContext` consumers will be taught to honor in a follow-up — **out of scope here is changing the generation read path**; this phase only manages the projection + UI truth.
- **`POST /api/tenant/memory/candidates/[id]/approve`** — load the queued finding (`aries_research_findings`), build an `ApprovedMessage`, call `honcho-client.appendApprovedMessage` (via orchestrator), `insertApprovedFact(status='approved')`, and `UPDATE aries_research_findings SET curator_decision='approved_by_operator', approved_message_id=… WHERE id=…`. Idempotent: re-approving an already-approved finding is a no-op (guard on `curator_decision`).
- **`POST /api/tenant/memory/candidates/[id]/reject`** — `UPDATE aries_research_findings SET curator_decision='rejected_by_operator'`. The finding leaves the pending list; never appended to Honcho.

**Resumability/idempotency:** approve is keyed by finding id; a partial failure (Honcho append succeeded, projection insert failed) is recoverable because the projection insert is idempotent on its deterministic id and the finding's `curator_decision` flip is the last write — a retry re-runs cleanly. No `Promise.all` fan-out over the pool (guardrail #1): these are single-row writes per request.

**Files touched:** `app/api/tenant/memory/facts/[id]/supersede/route.ts` (NEW), `app/api/tenant/memory/facts/[id]/route.ts` (NEW, DELETE), `app/api/tenant/memory/candidates/[id]/approve/route.ts` (NEW), `app/api/tenant/memory/candidates/[id]/reject/route.ts` (NEW), `backend/memory/memory-facts.ts` (mutation helpers), `backend/memory/research-jobs.ts` (add `setFindingDecision(tenantId, findingId, decision, approvedMessageId?)` helper + widen the decision string handling for `approved_by_operator`/`rejected_by_operator`; per CLAUDE.md "widening union → grep inequalities", grep every `curator_decision === 'queue_for_review'` / `!== 'queue_for_review'` site and confirm the pending list filter still excludes operator-resolved findings — note `listQueuedResearchFindingsForTenant` already filters `WHERE f.curator_decision = 'queue_for_review'` at research-jobs.ts:246, which is the load-bearing literal).

**Acceptance (non-UI):** approving a pending candidate moves it out of `pendingCandidates` and into the correct section on the next GET; supersede produces a new active fact + a `superseded` prior; delete removes a fact from active lists; reject removes a candidate; all reject non-`tenant_admin` with 403 and all 404 when the flag is OFF.

### D — Operator screen + page + nav (High, 5h)

**`frontend/aries-v1/memory-screen.tsx` (NEW)** — mirrors `review-queue.tsx`:
- `'use client'`; a `useMemoryFacts()` hook (new `hooks/use-memory-facts.ts`, modeled on `hooks/use-runtime-reviews.ts` — note runtime-reviews fetches via the `lib/api/aries-v1` layer; the memory hook may fetch `/api/tenant/memory/facts` directly).
- Reuse `ShellPanel`, `EmptyStatePanel`, `LoadingStateGrid`, `StatusChip` from `frontend/aries-v1/components` and `customerSafeUiErrorMessage` from `./customer-safe-copy`.
- Header `ShellPanel` eyebrow "Memory" title "What Aries knows about your business" with the safety-first framing sentence.
- Seven labeled section cards (brand facts, audience facts, voice preferences, rejected creative directions, approved publishing constraints, performance learnings, pending memory candidates). Each fact row renders: **claim**, a **source** line (first-party vs third-party badge + host of `sources[0].url`), a **status** chip (`approved`/`superseded`), a **used-in** line (the `research_job_id`, linking to the job workspace when resolvable), and the action row.
- Actions: **Edit** (inline textarea → `POST …/supersede`), **Supersede** (explicit alias of Edit for a corrected-fact flow), **Delete** (`DELETE`, confirm dialog). Pending candidates show **Approve** / **Reject**. When the session role is not `tenant_admin`, actions render disabled with a tooltip ("Only an admin can change memory.") — role is read from the screen's session prop (no client-trusted role; the API re-checks).
- Empty state per section ("Aries has not learned any brand facts yet.") and a global empty state when the tenant has zero memory. **This empty state is the expected initial render on tenant 15** until real approvals/seed land (Phase E) — the screen must look correct and trustworthy when empty.

**`app/dashboard/memory/page.tsx` (NEW)** — the short `results/page.tsx` pattern:
```tsx
import AppShellLayout from '@/frontend/app-shell/layout';
import AriesMemoryScreen from '@/frontend/aries-v1/memory-screen';
import { isMemoryScreenEnabled } from '@/backend/memory/honcho-env';
import { notFound } from 'next/navigation';

export default function DashboardMemoryPage() {
  if (!isMemoryScreenEnabled()) notFound();
  return (
    <AppShellLayout currentRouteId="memory" loginRedirectPath="/dashboard/memory">
      <AriesMemoryScreen />
    </AppShellLayout>
  );
}
```

**Nav wiring:**
- `frontend/app-shell/routes.ts` — add `'memory'` to `AppRouteId` and an `APP_ROUTES` entry `{ id:'memory', title:'Memory', href:'/dashboard/memory', section:'utility', description:'What Aries knows about your business — review, correct, and remove durable facts.' }`.
- `components/redesign/layout/app-shell-client.tsx` — add `memory:` to the `ICONS` map (32-47; use `Brain` or `BookOpen` from lucide — neither is imported yet, add the import), add `{ type:'link', routeId:'memory' }` to `utilityItems` (98-107). When the flag is OFF the route still exists in the union (TS), so gate the nav link render on a `memoryEnabled` prop threaded from the server shell (`app-shell.tsx`) — when OFF, filter the `memory` item out of `utilityItems` so it never renders. Optionally surface a pending-candidate **badge** reusing the `reviewCount` plumbing pattern (app-shell.tsx 141/145/173), computed from the pending count (best-effort, timeout-guarded — do not block render).

**Files touched:** `frontend/aries-v1/memory-screen.tsx` (NEW), `app/dashboard/memory/page.tsx` (NEW), `hooks/use-memory-facts.ts` (NEW), `frontend/app-shell/routes.ts`, `components/redesign/layout/app-shell-client.tsx`, `components/redesign/layout/app-shell.tsx` (thread `memoryEnabled` + optional badge count).

**Acceptance (USER-VISIBLE — this is the success bar):** logged in as the @sugarandleather tenant admin on `aries.sugarandleather.com` with the flag ON, the sidebar shows **Memory**; the page renders the seven sections with correct labels, empty states, and (when present) source badge / status chip / used-in line; a `tenant_viewer` sees the screen read-only with disabled actions. **Once at least one approved fact exists for the tenant** (produced by a live curation run or the seed step in Phase E), Brand facts shows >=1 real fact, **Edit** saves and the corrected claim renders with the prior marked superseded, **Delete** removes a fact from the active list on reload, and a **pending candidate Approve** moves it into its section. Rendered UI only — DB rows / API 200s do not count. Because tenant 15 currently has zero approved facts AND zero pending findings (verified), the realistic first user-visible PASS is the correctly-rendered seven-section screen with empty states; the fact-bearing acceptance items are gated on Phase E producing real data.

### E — Flag + docs + tests + produce-real-facts + live verify + ship (Medium, 4h)

1. **Flag** `ARIES_MEMORY_SCREEN_ENABLED` (default OFF) — add `isMemoryScreenEnabled(env=process.env)` to `backend/memory/honcho-env.ts` using the existing `1|true|yes|on` pattern. Document in `CLAUDE.md` "Environment Variables", `.env.example`, and `docker-compose.yml` (set `${ARIES_MEMORY_SCREEN_ENABLED:-0}` in compose to ship dark, matching the `ARIES_VIDEO_PUBLISH_ENABLED:-0` precedent). When OFF: page `notFound()`, all `/api/tenant/memory/*` routes 404, nav item hidden.
2. **Docs** — short note in the PRD §16.6/§17 area or a `docs/` line that the memory inspection UI now exists behind the flag (honest "current limitations" alignment, roadmap area 1d).
3. **Tests** (fixture-primary; set `APP_BASE_URL=https://aries.example.com`):
   - `tests/memory-facts-grouping.test.ts` (NEW) — `groupFactsIntoSections` maps each `(kind, peer)` to the right section; `audience` only via `peerHint`/tagging; superseded/deleted excluded.
   - `tests/memory-facts-route.test.ts` (NEW) — GET returns 7 sections + pending; flag OFF ⇒ 404; non-admin GET allowed, mutate ⇒ 403.
   - `tests/memory-facts-manage.test.ts` (NEW) — supersede inserts new + marks prior; delete soft-deletes; approve appends + projects + flips finding; reject flips finding; all idempotent on replay.
   - `tests/memory-facts-write-paths.test.ts` (NEW) — assert the projection insert fires from ALL THREE append paths (orchestrator, write-events, onboarding-seed) and that a thrown projection insert does NOT break the underlying Honcho append (best-effort isolation).
   - `tests/memory/memory-facts-live-db.test.ts` (NEW, `t.skip('database env not configured')` when DB env absent — precedent `tests/marketing/ingest-production-assets-live-db.test.ts:96`) — backfill + read against a real tenant-scoped DB.
   - Allowlist the unit/route tests in `scripts/verify-regression-suite.mjs` `steps` array.
4. **Produce real approved facts for tenant 15 (required for the fact-bearing acceptance bar).** The live DB has zero approved facts and zero pending findings for tenant 15, so the screen would render empty. Before claiming the fact-bearing acceptance items, EITHER (a) run a live curation/onboarding-seed pass for tenant 15 so genuine `brand`/`policy` (and, via write-events, `user`-peer preference) approvals land and the new hooks project them, OR (b) approve at least one genuine pending candidate through the new approve endpoint (which also produces a projection row). Do NOT hand-insert synthetic projection rows to fake the screen — per project memory, rendered UI must reflect real memory.
5. **Live E2E on tenant 15** — run the backfill (expect zero or few rows given the verified state), ensure real approved facts exist per step 4, flip the flag ON in the live container, walk the user-visible acceptance bar above on `aries.sugarandleather.com`, capture a screenshot of the rendered seven-section screen (and, once data exists, the Brand facts section + a successful Edit).
6. **CI-exact verify:** `npm run verify` then `npm run test:concurrent` (touches routes + backend + shared nav). Then `npm run guardrails:agent` before opening the PR. Ship via `/ship-triage-deploy`; bump `VERSION` (minor — new table + routes) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ no nav item, page 404, routes 404, zero behavior change; flag ON ⇒ full rendered seven-section screen verified on the live tenant (empty states correct when no data; fact-bearing actions verified once real approvals exist per step 4); `full-suite` gate green.

## Feature flag

`ARIES_MEMORY_SCREEN_ENABLED=1` — enables the operator-facing "What Aries knows about your business" memory transparency screen at `/dashboard/memory` and its `/api/tenant/memory/*` read+manage routes. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF: the page `notFound()`s, the nav entry is hidden, and all memory-management API routes return 404 — zero behavior change. When ON: any authenticated tenant member can view the seven memory sections (brand facts, audience facts, voice preferences, rejected creative directions, approved publishing constraints, performance learnings, pending memory candidates) with source/status/used-in per fact; `tenant_admin` may Edit (supersede), Delete (soft), and Approve/Reject pending candidates. The screen reads from the `aries_memory_facts` projection (approved facts, written at all three Honcho append sites) and `aries_research_findings` (pending) — it never enumerates Honcho by peer (unsupported in v3). This is a read+manage surface only; it never publishes and never writes net-new free-form memory.

## Data / contract changes

- **New table `aries_memory_facts`** — append-only projection of approved durable facts (write-time index over Honcho appends, which cannot be peer-enumerated). Written at all three append paths (`orchestrator`, `write-events`, `onboarding-seed`). Additive migration `20260601120000_memory_facts.sql`, mirrored in `scripts/init-db.js`.
- **`aries_research_findings.curator_decision`** gains operator-resolved values `approved_by_operator` / `rejected_by_operator` (string column, no schema change; grep all `=== 'queue_for_review'` / `!== 'queue_for_review'` literal checks per CLAUDE.md union-widening rule — the load-bearing one is research-jobs.ts:246).
- **No Honcho contract change** — approve reuses `appendApprovedMessage`; supersede reuses `ApprovedMessage.supersedes`.
- **New typed frontend-safe payload** from `/api/tenant/memory/facts` (sections + pendingCandidates + counts) — no raw rows, no file paths.

## Rollout

1. Land A-E behind `ARIES_MEMORY_SCREEN_ENABLED=0` (dark). Migration is additive + idempotent.
2. Run `scripts/backfill-memory-facts.mjs` against the live DB (idempotent; safe to re-run). Expect few/zero rows given the verified live state (no historical auto-approve findings); this is honest, not a failure.
3. Produce real approved facts for tenant 15 (live curation/seed pass or operator approval of a genuine candidate) so the screen has content to show.
4. Flip `ARIES_MEMORY_SCREEN_ENABLED=1` in the live container; walk the user-visible acceptance bar on `aries.sugarandleather.com`.
5. **Rollback:** set flag `=0` (instant — nav/page/routes go dark; projection table is inert and harmless). Reverse migration `DROP TABLE aries_memory_facts;` only if fully abandoning (no data loss to generation, which still reads Honcho).

## Out of scope

- **Changing the generation read path** (`loadResearchMemoryContext`) to honor `status='deleted'` — this plan manages the projection + UI truth; teaching the weekly planner to exclude deleted facts is a follow-up (the screen honestly says "Aries will stop using it" once that lands).
- **Peer-scoped Honcho enumeration / a real Honcho read API** — explicitly avoided (v3 has no peer-scoped list; the projection table is the workaround). Note: this is also why historical Honcho-only approves cannot be backfilled.
- **Operator typing net-new free-form facts into memory** — that is the onboarding/business-setup wizard (roadmap area 6).
- **Performance-driven memory candidates from results** ("Approve this learning?" loop) — that is roadmap area 11 / the Honcho performance-insights write-leg (#522, gated OFF); this screen will *display* such candidates once they land in `aries_research_findings`, but does not generate them.
- **Memory export / redaction tooling** (PRD §17 #7 export) — display + edit + delete only this pass.
- **Repointing `app/creative-memory/page.tsx`** — the internal prompt-recipe tool stays where it is, unlinked.
- **Role model expansion** (approver/strategist roles, roadmap area 14) — reuse existing `tenant_admin` gating.

## Risks

1. **Honcho cannot be enumerated by peer (v3), AND there are three independent append paths.** *Mitigated* by writing the `aries_memory_facts` projection at ALL THREE append sites (`orchestrator.appendCuratedFinding`, `write-events.appendHonchoApproved`, `onboarding-seed`) — verified that the latter two never write `aries_research_findings`, so a findings-table-only hook/backfill would silently miss voice-preference, approval-mirror, publish/performance, and onboarding-seed approvals. *Residue:* facts appended to Honcho before this change exist only in Honcho and are not recoverable (no peer enumeration); the screen surfaces them only as new approvals land. *Action:* grep all `appendApprovedMessage` call sites (currently `orchestrator.ts:108`, `write-events.ts:132`, `onboarding-seed.ts:54`, plus the client def) and confirm each non-client site also writes the projection; add a regression test (`memory-facts-write-paths.test.ts`).
2. **Live tenant has no approved facts yet.** Verified: `aries_research_findings` has zero auto-approve rows; tenant 15 has zero findings. The backfill inserts zero. *Mitigated* by an honest empty-state UI as the first user-visible PASS and a Phase-E step that produces real approvals before claiming the fact-bearing acceptance items. *Do not* hand-insert synthetic rows to fake content (project memory: rendered UI must reflect real memory).
3. **`appendCuratedFinding` (orchestrator hook) only fires for `brand`/`policy` peers.** Verified `peerRefForKind` (orchestrator.ts:41-45) returns null for `user`/`approver`, downgrading to queue. So the "Voice preferences" (`user`-peer) section is fed by the write-events path's projection hook, NOT the orchestrator hook. *Mitigated* by hooking write-events explicitly (Phase A item 2).
4. **Soft-delete vs generation drift.** Until the follow-up teaches `loadResearchMemoryContext` to honor `status='deleted'`, a deleted fact still influences weekly planning via Honcho. *Mitigated* by honest UI copy and tracking the follow-up; do not over-claim "removed."
5. **Hot-path write on approve (three sites).** The new `insertApprovedFact` runs inside each append path. *Mitigated* by wrapping each in try/catch + warn (best-effort, never throws into the existing append) and single-row writes (no pool fan-out, guardrail #1).
6. **Union widening on `curator_decision`.** New operator-resolved values can silently break literal-inequality pending-list filters (CLAUDE.md has shipped this class of bug 3×; the load-bearing literal is research-jobs.ts:246). *Mitigated* by the mandatory grep of `=== 'queue_for_review'` / `!== 'queue_for_review'` and a test asserting operator-resolved findings drop out of `pendingCandidates`.
7. **Treat-as-production.** Backfill and flag-flip run against the live DB/tenants. *Mitigated* by idempotent backfill, additive migration, default-OFF flag, and validating only on rendered UI on `aries.sugarandleather.com` (project memory: rendered dashboard = done).

## Files reference

| File | Change | Phase |
|------|--------|-------|
| `migrations/20260601120000_memory_facts.sql` | NEW: `aries_memory_facts` projection table | A |
| `scripts/init-db.js` | mirror table for fresh installs | A |
| `backend/memory/memory-facts.ts` | NEW: schema guard, insert/list/supersede/soft-delete, `groupFactsIntoSections` | A,B,C |
| `backend/memory/orchestrator.ts:108-113` | best-effort projection write on auto-approve (brand/policy) | A |
| `backend/memory/write-events.ts` | best-effort projection write in `appendHonchoApproved` (incl. `user`-peer prefs); thread tenant ctx | A |
| `backend/memory/onboarding-seed.ts:54` | best-effort projection write on seed auto-approve | A |
| `backend/memory/index.ts` | export new helpers/types | A |
| `backend/memory/research-jobs.ts` | `setFindingDecision` + operator-resolved decisions | C |
| `backend/memory/honcho-env.ts` | `isMemoryScreenEnabled` | E |
| `scripts/backfill-memory-facts.mjs` | NEW: idempotent projection backfill (findings-table source; honest empty-on-no-source) | A |
| `app/api/tenant/memory/facts/route.ts` | NEW GET: 7 sections + pending | B |
| `app/api/tenant/memory/facts/[id]/route.ts` | NEW DELETE (soft) | C |
| `app/api/tenant/memory/facts/[id]/supersede/route.ts` | NEW POST (edit/supersede) | C |
| `app/api/tenant/memory/candidates/[id]/approve/route.ts` | NEW POST | C |
| `app/api/tenant/memory/candidates/[id]/reject/route.ts` | NEW POST | C |
| `frontend/aries-v1/memory-screen.tsx` | NEW operator screen (7 sections, actions) | D |
| `hooks/use-memory-facts.ts` | NEW fetch hook | D |
| `app/dashboard/memory/page.tsx` | NEW page (flag-gated) | D |
| `frontend/app-shell/routes.ts` | add `memory` route id + entry | D |
| `components/redesign/layout/app-shell-client.tsx` | ICONS + utilityItems + flag filter | D |
| `components/redesign/layout/app-shell.tsx` | thread `memoryEnabled` + optional badge | D |
| `tests/memory-facts-grouping.test.ts` | NEW | E |
| `tests/memory-facts-route.test.ts` | NEW | E |
| `tests/memory-facts-manage.test.ts` | NEW | E |
| `tests/memory-facts-write-paths.test.ts` | NEW (projection fires from all 3 append paths) | E |
| `tests/memory/memory-facts-live-db.test.ts` | NEW (skip w/o DB) | E |
| `scripts/verify-regression-suite.mjs` | allowlist new tests | E |
| `CLAUDE.md`, `.env.example`, `docker-compose.yml` | document `ARIES_MEMORY_SCREEN_ENABLED` | E |
| `VERSION`, `CHANGELOG.md` | bump (minor) | E |

## Related

- Roadmap area 4 (this), build-first #6; P2 first-user experience.
- Roadmap area 11 / #522 (Honcho performance-insights write-leg, gated OFF) — feeds future performance-learning candidates this screen will display.
- `app/api/tenant/research/review-queue/route.ts` — the existing pending-candidate read this screen extends.
- PRD §16.6 / §17 Future #7 — "memory inspection UI" open item this closes (read+edit+delete pass; export deferred).
- CLAUDE.md guardrails honored: treat-as-production (idempotent backfill, default-OFF flag, rendered-UI success bar on `aries.sugarandleather.com`, no synthetic fact insertion), no autonomous publish (read+manage only), pool fan-out #1 (single-row writes), union-widening grep, route boundary (typed safe payloads).
