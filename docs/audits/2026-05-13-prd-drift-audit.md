# PRD Drift Audit — Aries AI Canonical PRD Alignment

Date: 2026-05-13  
Source of truth: `docs/product/aries-ai-prd.md`

## Scope

This audit identifies architectural drift between the canonical PRD and the current repository implementation, with emphasis on Hermes-native execution, social-content terminology, tenant boundaries, approvals, provider abstraction, memory lifecycle, and callback-driven orchestration.

## 1) Docs conflicting with Hermes-native direction

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `app/api-docs/page.tsx` | API examples/documentation are centered on `brand_campaign`, `/api/marketing/jobs`, and campaign-stage terminology (`strategy`, `production`, `publish`) as the default path. | PRD sets weekly social content + Hermes-native orchestration as current product center and treats older campaign framing as historical/compat. | Add a Hermes/social-content-first docs section and explicitly mark `brand_campaign` and OpenClaw-era flows as legacy compatibility paths. |
| `app/dashboard/brand-review/page.tsx` | Empty state and title are campaign-first (“No campaigns yet”, “Create a campaign…”). | PRD product language is social content/posts-first for current direction. | Rewrite user-facing copy to “social content jobs/posts” framing; keep campaign only where Meta Ads object semantics require it. |
| `app/dashboard/creative-review/page.tsx` | Empty state uses campaign-first copy (“Create a campaign…”). | Same terminology drift against current product direction. | Rename copy to social-content/post terminology. |
| `app/dashboard/publish-status/page.tsx` | Empty state says “Create a campaign to track approval gating…”. | Conflicts with social-content-first messaging. | Replace campaign wording with posts/social-content wording. |
| `tests/public-marketing-pages.test.ts` | Test still asserts route source contains `/dashboard/campaigns`. | Locks UI/docs to campaign route identity in user-visible paths. | Update assertions toward `/dashboard/social-content` and allow compatibility aliases only as non-primary behavior. |

## 2) Code paths still assuming deprecated OpenClaw/Lobster-native execution

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `backend/marketing/orchestrator.ts` | Still imports OpenClaw gateway resume/error helpers and legacy adapter symbols alongside Hermes path. | PRD marks provider-specific legacy execution as deprecated and expects capability-driven provider boundary with Hermes as active runtime path. | Isolate legacy compatibility behind strict adapter interfaces and remove direct OpenClaw semantics from orchestrator core. |
| `backend/marketing/ports/legacy-openclaw.ts` | Maintains full OpenClaw/Lobster run/resume adapter, env knobs, and pipeline file coupling. | Legacy is acceptable only as explicit compatibility path; current architecture should not rely on it as first-class operational surface. | Gate adapter behind explicit `legacy` compatibility flag and de-prioritize/remove once migration window closes. |
| `backend/openclaw/gateway-client.ts` | Contains gateway transport, env contract, state-dir logic, and workflow invocation for Lobster pipelines. | PRD direction is Hermes-native orchestration with provider abstraction; direct Lobster coupling is historical. | Keep only if required for backwards migration; otherwise quarantine under `legacy/` and prevent new imports outside adapter/tests. |
| `tests/marketing-pipeline-contract.test.ts` | Enforces contract of `.lobster` stage workflows and “campaign-planner” compatibility wiring. | Test suite currently codifies deprecated execution topology as required behavior. | Reframe as legacy-contract tests under explicit compatibility suite; add Hermes workflow-contract tests as canonical. |

## 3) “Campaign” terminology that should become “posts” / “social content”

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `app/dashboard/social-content/page.tsx` | Uses `AriesCampaignListScreen` and `currentRouteId="campaigns"`. | User-facing primary route still anchored to campaign naming. | Introduce `SocialContentListScreen` naming and route identity; retain compatibility aliases internally only. |
| `app/dashboard/social-content/[campaignId]/page.tsx` | URL param and component props are `campaignId`; logic maps to campaign view semantics. | Drift in user-facing model vocabulary vs posts/social content model. | Migrate canonical identifiers to `jobId` or `socialContentId`; preserve backwards route parsing with redirects. |
| `frontend/aries-v1/*campaign*` (multiple files) | Core UI components/models remain campaign-branded (`campaign-workspace`, `latest-campaign-view`, etc.). | Broad vocabulary mismatch with canonical direction. | Plan phased rename and copy normalization, starting with user-visible strings, then internal type names. |
| `tests/*campaign*` (multiple files) | Regression tests preserve campaign language in expected text and identifiers. | Reinforces outdated terminology and blocks rename. | Add social-content terminology tests first, then migrate legacy tests to compatibility subset. |

## 4) Missing tenant isolation boundaries

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `app/api/marketing/jobs/[jobId]/approve/route.ts` | Route wrapper delegates to handler; tenant safety depends entirely on downstream handler behavior. | PRD requires tenant context be server-derived and enforced at every boundary. | Verify and enforce explicit tenant-context extraction and tenant/job ownership check in handler entrypoint; document as invariant test. |
| `backend/openclaw/gateway-client.ts` | OpenClaw runtime context/session key handling is provider-centric; no explicit tenant namespace shaping in this layer. | PRD requires tenant context to shape callbacks, namespaces, and boundaries throughout orchestration components. | Ensure any compatibility path injects tenant-scoped correlation keys and forbids cross-tenant shared session defaults. |

## 5) Missing approval checkpoints

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `backend/marketing/orchestrator.ts` | Approval APIs exist for stage resumption, but workflow-specific policy boundary (what must be human-approved vs auto-approved) is partially implicit in stage logic. | PRD requires explicit approval policy for high-impact actions, memory promotion, and publishing. | Centralize approval policy matrix (stage × action × role) in a single policy module and make orchestrator consume it deterministically. |
| `app/api-docs/page.tsx` | Approval endpoint docs focus on stage progression, not explicit policy reasons/guardrails. | PRD emphasizes approval intent, actor traceability, and restricted auto-approval scopes. | Extend docs with approval policy semantics, actor requirements, and disallowed bypass flows. |

## 6) Missing provider abstraction boundaries

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `backend/marketing/orchestrator.ts` | Orchestrator still imports provider-specific OpenClaw token/error semantics directly. | PRD expects workflows to request capabilities and avoid provider-specific behavior in product orchestration core. | Move provider-specific parsing/errors into adapters; orchestrator should consume normalized `ExecutionPort` errors/outcomes only. |
| `backend/marketing/execution-port.ts` | Interface is Hermes-only in name union (`'hermes'`), but comments/fields still include legacy OpenClaw timeout/stdout semantics. | Mixed abstraction leaks legacy transport concerns into canonical provider interface. | Remove legacy-only fields from canonical interface; if needed, add adapter-private config objects not visible to orchestration core. |

## 7) Missing memory lifecycle / pseudonymization boundaries

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `backend/marketing/orchestrator.ts` + approval/memory calls | Memory writes are scheduled on approval paths, but lifecycle gates (candidate → review queue → approved durable memory) are not obvious as one explicit state machine at this entrypoint. | PRD requires curated memory lifecycle with provenance, approval state, and strict promotion controls. | Introduce explicit memory-candidate state transitions with auditable statuses and enforce them before durable writes. |
| Repository-wide naming for memory workspace references | No single obvious boundary document/module in this audit slice that guarantees pseudonymized workspace naming invariant for every write path. | PRD requires tenant pseudonymization boundary for memory namespaces. | Add/expand invariant tests around `aries-tenant-<pseudonym>` mapping and ensure all memory-write call sites route through that mapper. |

## 8) Runtime paths needing webhook/API-driven orchestration vs direct coupling

| File path | Current behavior | PRD conflict | Recommended action |
|---|---|---|---|
| `backend/marketing/ports/legacy-openclaw.ts` + `backend/openclaw/gateway-client.ts` | Legacy path performs direct run/resume coupling to Lobster/OpenClaw execution semantics. | PRD direction is provider-boundary submission + callback re-entry, with Aries owning job truth. | Continue migration: prefer submit-and-callback patterns (as already used in Hermes internal callback route) for all long-running stages. |
| `app/api/internal/hermes/runs/route.ts` | Good callback entrypoint exists with internal auth + callback token verification + idempotent handling. | This aligns with PRD and should be the model everywhere. | Treat this as canonical blueprint; retire or wrap direct-coupled execution paths to match this callback contract model. |

## Priority Recommendations

1. **Terminology normalization pass (high):** user-visible “campaign” copy/routes/components should shift to social-content/posts defaults while preserving compatibility aliases.
2. **Orchestrator de-legacying (high):** remove provider-specific OpenClaw logic from orchestrator core; keep legacy in quarantined adapter only.
3. **Approval + memory policy codification (high):** create explicit policy/state-machine modules for publish approvals and memory promotion gates.
4. **Tenant/memory invariants (medium-high):** add tests that enforce tenant-derived context and pseudonymized memory namespace mapping on every write/callback path.
5. **Docs realignment (medium):** refresh API docs and dashboard empty states to reflect Hermes-native weekly social content as canonical runtime.
